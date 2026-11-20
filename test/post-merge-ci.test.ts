// Which merges post-merge has watched (audit S5, ADR 0021 decision 3): the
// merged pull request's watched record says so, not the marker in the comment
// a run leaves, so deleting that comment doesn't get the merge watched again.
// A merge watched before runs recorded it has only the marker, which still
// counts until backfill writes its record. The recipe and its document read
// and write alike.
//
// And a watch whose push CI is still pending parks (audit W9, decision 4):
// the run records awaiting-merge-ci with the merge commit and when the watch
// began, and ends there. The trigger holds it while CI pends with time left
// and offers it as work a run may start once CI settles or the time is up,
// both counted from when the watch began; the run that takes it up reads CI
// once and ends as a watch that never parked would.

import { type CiReport, DEFAULT_LABELS, type Json, type WorkItem } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import postMerge from "../packages/recipes/flows/post-merge.ts";
import { mayStart } from "../src/modules/runs/domain/run/work-item.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import { documentOf, loadFlow, POST_MERGE_DOCUMENT } from "./compose-harness.ts";
import { effect } from "./effect-test.ts";
import {
  type EngineRun,
  type Fake,
  flowTriggered,
  item,
  makeFake,
  PULL,
  repo,
  runToEnd,
  runUntil,
  summaryOf,
} from "./sdk-fakes.ts";

// The engine runs below take milliseconds alone, but under the whole suite's
// load the engine's runner can miss health checks for seconds.
const ENGINE_TIMEOUT = 60_000;

// The signal a parked watch waits on, which nothing sends: the run ends there.
const MERGE_CI_SETTLED = "merge-ci-settled";

const RUN = "https://github.com/dataquail/demo/actions/runs/41/job/42";

const RED: CiReport = {
  state: "red",
  failedChecks: ["test"],
  failedRuns: [{ name: "test", url: RUN, job: Option.some(42), workflowRun: Option.some(41) }],
};

const MERGE = "merge5678";
const PR_ITEM = `pr-${PULL}`;
const KEY = `merged-${PULL}`;

const work = item(KEY, {
  pullRequest: PULL,
  url: `https://github.com/dataquail/demo/pull/${PULL}`,
  title: "feat: a change",
  mergeSha: MERGE,
  baseRef: "main",
});

// The persona's pull request, merged a moment ago, in a CI job.
const mergedPull = () => {
  const fake = makeFake("approve", { ciJob: true });
  fake.states.pull = "merged";

  return fake;
};

const forms = [
  ["the recipe", Effect.succeed(postMerge)],
  ["the document", loadFlow(documentOf(POST_MERGE_DOCUMENT))],
] as const;

// Whether the run waits on a parked watch's signal, as one that ended at its park does.
const parkedOnCi = (run: EngineRun) =>
  Effect.map(listRunWaitsHandler({ runId: run.id, signal: MERGE_CI_SETTLED }), ({ waits }) =>
    waits.some((wait) => wait.deferred === `${MERGE_CI_SETTLED}:merge-ci`),
  );

// The merged pull request's record: its phase and data.
const recordNow = (fake: Fake) =>
  Option.map(Option.fromUndefinedOr(fake.records().get(PR_ITEM)), (found) => ({
    phase: `${found.phase}`,
    data: Option.getOrElse(found.data, (): { readonly [key: string]: Json } => ({})),
  }));

const pendingOn = (waitingOn: ReadonlyArray<string>): CiReport => ({
  state: "pending",
  waitingOn: [...waitingOn],
  failedRuns: [],
});

for (const [form, loading] of forms) {
  const offeredItems = (fake: Fake) =>
    Effect.gen(function* () {
      return yield* flowTriggered(fake, yield* loading);
    }).pipe(Effect.orDie);

  const offered = (fake: Fake) =>
    Effect.map(offeredItems(fake), (items) => items.map((found) => found.key));

  const handle = Effect.map(loading, (flow) => flowHandle(repo, "post-merge", flow));

  // What a first run's park left on a fresh merge whose push CI was pending:
  // its record's data, to seed a later fake's record with.
  const parkedData = Effect.gen(function* () {
    const fake = mergedPull();
    fake.commitCi.set(MERGE, pendingOn(["test"]));
    yield* runUntil(yield* handle, fake, work, parkedOnCi);

    return Option.getOrThrow(Option.map(recordNow(fake), (found) => found.data));
  });

  // A merge whose watch a run parked `ago`, then ended at the park: its
  // record, and the watching comment the run left, with CI now `ci`.
  const parkedEarlier = (ci: CiReport, ago: Duration.Duration) =>
    Effect.gen(function* () {
      const data = yield* parkedData;
      const since = DateTime.subtractDuration(yield* DateTime.now, ago);
      const fake = mergedPull();
      fake.comment(`Watching CI on \`main\` at ${MERGE}.`);
      fake.commitCi.set(MERGE, ci);

      fake.recordPhase(PR_ITEM, "awaiting-merge-ci", {
        at: DateTime.makeUnsafe(0),
        data: { ...data, since: DateTime.formatIso(since) },
      });

      return fake;
    });

  // The one item the trigger offers for the merge.
  const offeredWatch = (fake: Fake) =>
    Effect.flatMap(offeredItems(fake), (items) =>
      Effect.fromOption(Arr.findFirst(items, (found) => found.key === KEY)),
    ).pipe(Effect.orDie);

  // Takes the parked watch up, as the run its trigger starts.
  const resumed = (fake: Fake) =>
    Effect.gen(function* () {
      const taken: WorkItem = yield* offeredWatch(fake);
      expect(mayStart(taken)).toBe(true);

      return yield* runToEnd(yield* handle, fake, taken);
    });

  const watchingComments = (fake: Fake) =>
    fake.comments.filter((comment) => comment.body.includes("Watching CI")).length;

  // The watch finished: the record says watched with the merge commit, and
  // the trigger no longer offers it.
  const watchFinished = (fake: Fake) =>
    Effect.gen(function* () {
      expect(recordNow(fake)).toEqual(Option.some({ phase: "watched", data: { sha: MERGE } }));
      expect(yield* offered(fake)).toEqual([]);
    });

  describe(`post-merge's ${form}, on a merge whose push CI is pending`, () => {
    effect(
      "records awaiting-merge-ci with the merge commit and when the watch began, and ends at the park",
      () =>
        Effect.gen(function* () {
          const before = yield* DateTime.now;
          const fake = mergedPull();
          fake.commitCi.set(MERGE, pendingOn(["test"]));
          let parked = false;

          const run = yield* runUntil(yield* handle, fake, work, (polled) =>
            Effect.map(parkedOnCi(polled), (found) => {
              parked = found;

              return found;
            }),
          );

          expect([run.status, parked]).toEqual(["running", true]);

          const recorded = Option.getOrThrow(recordNow(fake));
          expect(recorded.phase).toBe("awaiting-merge-ci");
          expect(recorded.data.sha).toBe(MERGE);

          const since = Option.flatMap(
            Schema.decodeUnknownOption(Schema.Struct({ since: Schema.String }))(recorded.data),
            (found) => DateTime.make(found.since),
          );

          expect(
            Option.exists(since, (began) => DateTime.isGreaterThanOrEqualTo(began, before)),
          ).toBe(true);

          // The document's record says where it resumes; the recipe's needn't.
          expect("resume" in recorded.data).toBe(form === "the document");
          expect(watchingComments(fake)).toBe(1);
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "is held, with why, while CI is still pending and the watch has time left",
      () =>
        Effect.gen(function* () {
          const fake = yield* parkedEarlier(pendingOn(["test"]), Duration.minutes(1));
          const held = yield* offeredWatch(fake);

          expect(mayStart(held)).toBe(false);
          expect(held.held).toBe("waits on push CI on merge56: test");

          // No CI yet, within noCiGrace, is held too.
          fake.commitCi.set(MERGE, pendingOn([]));
          expect((yield* offeredWatch(fake)).held).toBe("waits for push CI to start on merge56");
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "once CI went green, is offered, and the run that takes it up ends done",
      () =>
        Effect.gen(function* () {
          const fake = yield* parkedEarlier(
            { state: "green", failedRuns: [] },
            Duration.minutes(5),
          );

          const run = yield* resumed(fake);

          expect(run.status).toBe("done");
          expect(summaryOf(run)).toBe(`#${PULL}: CI on merge56 is green`);
          // It marked nothing and commented nothing again.
          expect(watchingComments(fake)).toBe(1);
          yield* watchFinished(fake);
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "once CI went red, is offered, and the run that takes it up files the follow-up once",
      () =>
        Effect.gen(function* () {
          const fake = yield* parkedEarlier(RED, Duration.minutes(5));
          fake.logTails.set(RUN, "error: expected 2, got 3");
          const run = yield* resumed(fake);

          expect(run.status).toBe("done");

          const filed = [...fake.graph.made.values()];
          expect(filed).toHaveLength(1);
          expect(fake.labelsOf(filed[0]?.number ?? 0)).toEqual([DEFAULT_LABELS.eligible]);
          expect(summaryOf(run)).toBe(
            `#${PULL}: CI on merge56 is red; filed #${filed[0]?.number} to fix it`,
          );
          yield* watchFinished(fake);
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "with no CI past noCiGrace, counted from when the watch began, is offered and ends done",
      () =>
        Effect.gen(function* () {
          const fake = yield* parkedEarlier(pendingOn([]), Duration.minutes(11));
          const run = yield* resumed(fake);

          expect(run.status).toBe("done");
          expect(summaryOf(run)).toBe(
            `#${PULL}: no CI ran on merge56 within 10m; taken as none for this push`,
          );
          yield* watchFinished(fake);
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "still pending past ciTimeout, counted from when the watch began, ends needing a person",
      () =>
        Effect.gen(function* () {
          const fake = yield* parkedEarlier(pendingOn(["test"]), Duration.days(2));
          const run = yield* resumed(fake);

          expect(run.status).toBe("needs-human");
          expect(summaryOf(run)).toContain("stayed pending for");
          yield* watchFinished(fake);
        }),
      ENGINE_TIMEOUT,
    );
  });

  describe(`post-merge's ${form}, on a merge`, () => {
    effect("recorded watched, isn't watched again, though no marker says so", () =>
      Effect.gen(function* () {
        const fake = mergedPull();
        fake.recordPhase(PR_ITEM, "watched", {
          at: yield* DateTime.now,
          data: { sha: MERGE },
        });

        expect(fake.comments).toEqual([]);
        expect(yield* offered(fake)).toEqual([]);
      }),
    );

    effect("that nobody watched, is offered, even past its review's record", () =>
      Effect.gen(function* () {
        const fake = mergedPull();
        expect(yield* offered(fake)).toEqual([KEY]);

        fake.recordPhase(PR_ITEM, "approved", { at: yield* DateTime.now });
        expect(yield* offered(fake)).toEqual([KEY]);
      }),
    );

    effect(
      "a run records it watched with its merge commit, and it stays watched once the comment goes",
      () =>
        Effect.gen(function* () {
          const fake = mergedPull();
          fake.recordPhase(PR_ITEM, "approved", { at: yield* DateTime.now });

          const finished = yield* runToEnd(
            flowHandle(repo, "post-merge", yield* loading),
            fake,
            work,
          );

          expect(finished.status).toBe("done");

          const recorded = Option.fromUndefinedOr(fake.records().get(PR_ITEM));
          expect(Option.map(recorded, (found) => `${found.phase}`)).toEqual(Option.some("watched"));
          expect(
            Option.map(
              Option.flatMap(recorded, (found) => found.data),
              (data) => data.sha,
            ),
          ).toEqual(Option.some(MERGE));

          fake.comments.splice(0);
          expect(yield* offered(fake)).toEqual([]);
        }),
    );
  });
}
