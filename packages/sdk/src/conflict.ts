// resolve-conflicts' wait for CI on the merge it pushed, as a park (ADR 0021,
// decision 4; audit W6). The pull request is open and under review, so its
// record holds a review phase, such as review-asked or approved, that other
// flows read. The wait parks on a phase of its own, awaiting-conflict-ci
// (Phases.inRound), not awaiting-fix-ci, which address-review reads as the wait
// on its own fix; and its data keeps the record it parked over, `restore`,
// which the run that takes the wait up records again once the wait ends,
// however it ends. While it is parked no other flow's source reads the
// pull request's phase, as none did while the run that waited owned it.
//
// Every pull request a run opened has a record (backfill gave one to those
// from before records), so one with none goes to a person. A wait whose
// record, kept beside the rest, doesn't fit the record's 4 KB polls.

import {
  activity,
  GitHub,
  NeedsHuman,
  type PhaseData,
  type PhaseRecord,
  reportAs,
  type WorkItem,
} from "@chernabog/core";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Implement from "./implement.ts";
import * as Phases from "./phases.ts";
import * as Review from "./review.ts";

// The record a wait parked over: its phase, and the data it carried, if any.
const Restore = Schema.Struct({
  phase: Schema.String,
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});

export type Restore = typeof Restore.Type;

// What a parked wait's record keeps beside where a document resumes: the
// record it parked over, and when the round's wait began, which every
// wait for CI keeps.
const Parked = Schema.Struct({ restore: Restore, since: Schema.optionalKey(Schema.String) });

const decodeParked = Schema.decodeUnknownOption(Parked);

// The steps of a wait: its CI steps carry `#resolve`, as they did before.
const ID = "resolve";

// The record a wait would park over, from the pull request's record now:
// the record itself, or, for one a run already parked over, the record that
// run kept. None for a parked one that kept none.
const parkedOver = (record: PhaseRecord): Option.Option<Restore> => {
  if (Option.isSome(Phases.roundOf(Phases.PHASES.pullRequest.awaitingConflictCi, record.phase))) {
    return Option.map(Option.flatMap(record.data, decodeParked), (parked) => parked.restore);
  }

  return Option.some(
    Option.match(record.data, {
      onNone: (): Restore => ({ phase: record.phase }),
      onSome: (data): Restore => ({ phase: record.phase, data }),
    }),
  );
};

// The pull request's record before the wait, read once (review-phase#resolve).
// One with no record to put back goes to a person.
const reviewPhase = (pullRequest: number) =>
  activity(
    `review-phase#${ID}`,
    Effect.flatMap(Phases.current(Phases.pullRequestItem(pullRequest)), (found) =>
      Effect.mapError(
        Effect.fromOption(Option.flatMap(found, parkedOver)),
        () =>
          new NeedsHuman({
            reason: `#${pullRequest} has no record for the wait on CI to park over and put back; chernabog progress backfill gives it one`,
          }),
      ),
    ),
    Restore,
  );

// Where a recipe's wait parks: on the pull request's record, with what it
// parked over, when that fits a record.
export const parkOnPullRequest = (pullRequest: number) => (restore: Restore) =>
  Effect.succeed(
    Option.map(Option.liftPredicate({ restore }, Phases.fitsAPark), (data) => ({
      item: Phases.pullRequestItem(pullRequest),
      data,
    })),
  );

// Records the phase the wait parked over again, once it has ended, when the
// pull request still holds the wait's phase (restored#resolve). Nothing for a
// wait that never parked, or a record another writer moved since.
const restoreReview = (pullRequest: number, restore: Restore) =>
  activity(
    `review-restored#${ID}`,
    Effect.gen(function* () {
      const item = Phases.pullRequestItem(pullRequest);
      const found = yield* Phases.current(item);

      const parked = Option.filter(found, (record) =>
        Option.isSome(Phases.roundOf(Phases.PHASES.pullRequest.awaitingConflictCi, record.phase)),
      );

      if (Option.isSome(parked)) {
        yield* Phases.record(item, restore.phase, restore.data);
      }
    }),
  );

// Waits for CI on the merge resolve-conflicts pushed, fixing red in the
// session that resolved the conflict, as Implement.waitForCi does. A first
// reading still pending records awaiting-conflict-ci on the pull request, with
// the record it parks over and when the wait began, and parks (`parkAt` says
// where: parkOnPullRequest for the recipe, Resume.parking for a document).
// A run that takes it up waits on from `firstRound`, and past ciTimeout,
// counted from when the round began, fails with CiTimedOut. However the wait
// ends, short of the park, the record it parked over is recorded again.
export const waitForCi = <E, R>(
  pullRequest: number,
  worktree: string,
  target: Implement.CiBranch,
  parkAt: (
    restore: Restore,
  ) => Effect.Effect<Option.Option<{ readonly item: string; readonly data: PhaseData }>, E, R>,
  firstRound: Option.Option<number> = Option.none(),
) =>
  Effect.gen(function* () {
    const restore = yield* reviewPhase(pullRequest);
    const parking = yield* parkAt(restore);

    const from = Option.match(firstRound, {
      onNone: () => ({}),
      onSome: (round) => ({ firstRound: round }),
    });

    const options = Option.match(parking, {
      onNone: (): Implement.CiWait => ({ id: ID, ...from }),
      onSome: ({ data, item }): Implement.CiWait => ({
        id: ID,
        ...from,
        park: (round) => ({
          item,
          phase: Phases.inRound(Phases.PHASES.pullRequest.awaitingConflictCi, round),
          data,
        }),
      }),
    });

    const waited = yield* Effect.exit(Implement.waitForCi(pullRequest, worktree, target, options));

    // A run ended at its park is interrupted there: its record stays parked.
    if (Exit.isFailure(waited) && Cause.hasInterrupts(waited.cause)) {
      return yield* waited;
    }

    yield* restoreReview(pullRequest, restore);

    return yield* waited;
  });

// The item, held with why while its wait hasn't settled.
const heldUnlessSettled = (pullRequest: number, data: PhaseData, item: WorkItem) =>
  Effect.map(Implement.heldOnCi(pullRequest, Option.some(data)), (held) =>
    Option.match(held, {
      onNone: () => item,
      onSome: (why): WorkItem => ({ ...item, held: why }),
    }),
  );

// The round of a parked wait a recipe's run takes up, from its work item.
const ResumingItem = Schema.Struct({ resumeCi: Schema.Struct({ round: Schema.Finite }) });

export const resumingCi = (item: WorkItem): Option.Option<number> =>
  Option.map(Schema.decodeUnknownOption(ResumingItem)(item.data), (found) => found.resumeCi.round);

// Pull requests this persona wrote whose resolve-conflicts recipe run parked
// on CI for its merge (their record is awaiting-conflict-ci, with no
// document's `resume`), as work items that take the wait up: held while the
// checks are pending and ciTimeout hasn't passed, and free to start once CI
// is green or red, or the time is up. One a person has (its record is
// with-person, so not parked), or a run owns, is left alone. A document's
// parks are Resume.parked's.
export const parkedOnCi = Effect.gen(function* () {
  const all = yield* Phases.records;
  const items: Array<WorkItem> = [];

  for (const pull of yield* Review.authoredByMe) {
    const found = Phases.recordOf(all, Phases.pullRequestItem(pull.number));

    const parked = Option.flatMap(found, (record) =>
      Option.map(
        Option.all({
          round: Phases.roundOf(Phases.PHASES.pullRequest.awaitingConflictCi, record.phase),
          data: record.data,
        }),
        ({ data, round }) => ({ record, data, round }),
      ),
    );

    if (
      Option.isNone(parked) ||
      "resume" in parked.value.data ||
      (yield* Review.ownedByARun(pull))
    ) {
      continue;
    }

    const { data, record, round } = parked.value;

    const item: WorkItem = {
      key: Phases.keyFor(Phases.pullRequestItem(pull.number), record),
      title: pull.title,
      url: pull.url,
      data: {
        pullRequest: pull.number,
        headRef: pull.headRef,
        baseRef: pull.baseRef,
        resumeCi: { round },
      },
    };

    items.push(yield* heldUnlessSettled(pull.number, data, item));
  }

  return items;
});

const DocumentConflict = Schema.Struct({ pullRequest: Schema.Finite });

// Whether a document's run parked on CI for its merge may be taken up, as
// parkedOnCi says for the recipe's. One whose pull request closed or went to
// a person has nothing left to resume.
export const documentCiResumes = (data: PhaseData, item: WorkItem) =>
  Effect.gen(function* () {
    const parked = Schema.decodeUnknownOption(DocumentConflict)(item.data);

    if (Option.isNone(parked)) {
      return Option.none<WorkItem>();
    }

    const github = yield* GitHub;

    const pull = yield* github.pullRequest(parked.value.pullRequest).pipe(
      Effect.asSome,
      Effect.catchTag("NotFound", () => Effect.succeedNone),
    );

    if (
      Option.isNone(pull) ||
      pull.value.state !== "open" ||
      (yield* Phases.withPerson(Phases.pullRequestItem(pull.value.number)))
    ) {
      return Option.none<WorkItem>();
    }

    return Option.some(yield* heldUnlessSettled(parked.value.pullRequest, data, item));
  }).pipe(reportAs("trigger"));

// What a document's run at conflict.waitForCi parks with: what the record
// parked over beside where it resumes, when the node can resume (Resume.parking).
export const keptWith = (restore: Restore) => ({ restore });
