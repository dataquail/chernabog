// How a run of a flow document takes up an item where a run before it parked
// (ADR 0021, decision 4). A run ends at every park, and a park is a phase
// boundary: each park site records a phase of its own (Phases.PARKS), so the
// phase alone says where the next run starts, and the record holds only the
// facts that run needs, never a step's output.
//
// The document's source of parked items (`parked`) offers, for each phase
// one of its nodes parks on, the items that node's block says a run may take
// up (Block.parks.offers): built from each record's thread and data, routed
// to a persona as its source routes them, and held, with why, while what it
// waits on hasn't settled. The run that takes one up starts at that node,
// whose block takes the wait up from the record and the world
// (Block.parks.takeUp), and goes on from there. Nothing before the park runs
// again, and nothing it gave carries over: the compiler holds the steps after
// a park to reading the trigger, what the park records (its block's output),
// and what comes after it.

import {
  activity,
  Claims,
  type FlowError,
  GitHub,
  type Json,
  Markers,
  type ReportedError,
  Skip,
  StepFailed,
  type TriggerServices,
  type WorkItem,
} from "@chernabog/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Phases from "./phases.ts";
import * as Settings from "./settings.ts";
import * as StatusLabels from "./status-labels.ts";

// Whether a block runs at a node its document can take its park up at: none
// in a recipe, or at a node a run can't be taken up at, such as in a
// forEach's lanes, where a wait that can waits inside the run instead.
export const Parkable = Context.Reference<boolean>("@chernabog/sdk/Parkable", {
  defaultValue: () => false,
});

// Runs a block at a node its document can take its park up at.
export const parkable = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Parkable, true);

// Where a block records its wait, and the facts it records: on the item the
// document's run works on, at a node a run can take it up at; none anywhere
// else, where the block waits inside the run.
export const parking = (data: { readonly [key: string]: Json }) =>
  Effect.gen(function* () {
    const can = yield* Parkable;
    const on = yield* Phases.RecordedOn;

    return Option.map(
      Option.filter(on, () => can),
      (item) => ({ item, data }),
    );
  });

// What a work item a run takes up carries, under `resume`: the phase it parked
// on, its site's, without the round of a wait for CI.
const Resuming = Schema.Struct({ resume: Schema.Struct({ site: Schema.String }) });

// The phase a work item from a parked record parked on, which says the node
// its run starts at; none for any other item.
export const resumedAt = (item: WorkItem): Option.Option<string> =>
  Option.map(Schema.decodeUnknownOption(Resuming)(item.data), (data) => data.resume.site);

const JsonObject = Schema.Record(Schema.String, Schema.Json);

// The item, as one a run takes up from a record parked on `site`: every
// block's items carry an object of data, which says what the item is.
const resuming = (item: WorkItem, site: string): WorkItem => {
  const data = Option.getOrElse(Schema.decodeUnknownOption(JsonObject)(item.data), () => ({}));

  return { ...item, data: { ...data, resume: { site } } };
};

// A block as a document's generated flow names it, by what it says of its park.
type Parking<P> = { readonly name: string; readonly parks: Option.Option<P> };

const noPark = (block: { readonly name: string }) =>
  new StepFailed({ step: `resume-${block.name}`, message: `${block.name} doesn't park` });

// The block's output for a run that takes up the item it parked (Block.parks),
// from the record and the world, given what the document gives it under
// `with`, and what its failures mean.
export const takeUp = <F, O, A, E, R>(
  block: Parking<{
    readonly takeUp: (item: WorkItem, fixed: F, overrides?: O) => Effect.Effect<A, E, R>;
  }>,
  item: WorkItem,
  fixed: F,
  overrides?: O,
): Effect.Effect<A, E | StepFailed, R> =>
  Option.match(block.parks, {
    onNone: () => Effect.fail(noPark(block)),
    onSome: (parks) => parks.takeUp(item, fixed, overrides),
  });

// The round of the repeat a taken-up item parked in, by its block's say: a
// step that fails for an item that says none.
export const round = (
  block: Parking<{
    readonly site: string;
    readonly round: Option.Option<(item: WorkItem) => Option.Option<number>>;
  }>,
  item: WorkItem,
) =>
  Effect.gen(function* () {
    const found = Option.flatMap(block.parks, (parks) =>
      Option.flatMap(parks.round, (roundOf) => roundOf(item)),
    );

    if (Option.isNone(found)) {
      return yield* new StepFailed({
        step: `resume-${block.name}`,
        message: `the item ${block.name} parked says no round of its repeat`,
      });
    }

    return found.value;
  });

// The pull request a failure taking up the item's park tells a person of, by
// its block's say.
export const pullRequestOf = <N>(
  block: Parking<{ readonly pullRequest: Option.Option<(item: WorkItem) => Option.Option<N>> }>,
  item: WorkItem,
): Option.Option<N> =>
  Option.flatMap(block.parks, (parks) => Option.flatMap(parks.pullRequest, (named) => named(item)));

// Holds what claiming issue `issue` puts on it, as markers the run releases
// however it ends: the board Status to move back to, if the repo has a board,
// and the persona's assignment. Kept when the run is done, when the pull
// request carries on, and on `keepOn` too. Implement.markClaimed holds them
// before putting them on; a run that takes the issue up holds them again,
// as its own, for what the run that parked put on (claimAgain).
export const holdClaimMarkers = (issue: number, options: Markers.HoldOptions = {}) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const board = yield* Settings.board;
    const keepOn: ReadonlyArray<Markers.Ending> = ["done", ...(options.keepOn ?? [])];

    for (const found of Option.toArray(board)) {
      yield* Markers.hold(
        Markers.boardStatus,
        { number: issue, status: found.readyStatus },
        { keepOn },
      );
    }

    yield* Markers.hold(
      Markers.assignment,
      { number: issue, login: yield* github.login },
      { keepOn },
    );

    return board;
  });

// The issue `item` names, if it names one.
const issueNumber = (item: string) =>
  Option.map(Option.fromNullOr(/^issue-(\d+)$/.exec(item)), (found) => Number(found[1]));

// A run that takes `item` up claims it again, as the run that parked held it
// until it ended: it takes the claim ref back, and says nothing on the item,
// which the parked run's claim did already. What that claim put on an issue,
// the persona's assignment and the board Status, the parked run kept for this
// one; this run holds them again (holdClaimMarkers, with `keepOn` as the claim
// gave it), so its ending lets them go as the parked run's would have.
export const claimAgainOn = (item: string, options: Markers.HoldOptions = {}) =>
  activity(
    "claim-again",
    Effect.gen(function* () {
      const claimed = yield* StatusLabels.acquire(item);

      if (!claimed.acquired) {
        return yield* new Skip({
          reason: `${item} is already claimed (${Claims.describeHolder(item, claimed.holder)})`,
        });
      }

      for (const issue of Option.toArray(issueNumber(item))) {
        yield* holdClaimMarkers(issue, options);
      }
    }),
  );

// claimAgainOn the item a document's run records on, which for an issue is
// its claim's, for a claim that kept its markers on `keepOn` too, as
// hybrid.claim does on failed.
export const claimAgainKeeping = (keepOn: ReadonlyArray<Markers.Ending>) =>
  Effect.gen(function* () {
    for (const item of Option.toArray(yield* Phases.RecordedOn)) {
      yield* claimAgainOn(item, { keepOn });
    }
  });

// claimAgainOn the item a document's run records on, for issue.claim's claim.
export const claimAgain = claimAgainKeeping([]);

// The source a document whose nodes park gets: for each phase one of them
// parks on, the items its block offers, as work a run may start, never only
// a wake (ADR 0021, decision 4), each saying the phase it parked on.
export const parked = (
  flow: string,
  sites: ReadonlyArray<{
    readonly site: string;
    readonly offers: (
      flow: string,
    ) => Effect.Effect<ReadonlyArray<WorkItem>, FlowError | ReportedError, TriggerServices>;
  }>,
) =>
  Effect.gen(function* () {
    const items: Array<WorkItem> = [];

    for (const { offers, site } of sites) {
      for (const item of yield* offers(flow)) {
        items.push(resuming(item, site));
      }
    }

    return items;
  });
