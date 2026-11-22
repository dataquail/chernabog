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
  type Json,
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

// A run that takes an item up claims it again, as the run that parked held it
// until it ended: on the item it records on, which for an issue is its claim's.
export const claimAgain = Effect.gen(function* () {
  const on = yield* Phases.RecordedOn;

  for (const item of Option.toArray(on)) {
    yield* activity(
      "claim-again",
      Effect.gen(function* () {
        const claimed = yield* Claims.acquire(item);

        if (!claimed.acquired) {
          return yield* new Skip({
            reason: `${item} is already claimed (${Claims.describeHolder(item, claimed.holder)})`,
          });
        }
      }),
    );
  }
});

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
