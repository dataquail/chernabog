// resolve-conflicts' wait for CI on the merge it pushed parks (audit W6, ADR
// 0021 decision 4). The pull request is open and under review, so its record
// holds a review phase; the wait parks on awaiting-conflict-ci, not on
// awaiting-ci, which address-review reads as its own fix's wait, and keeps
// the record it parked over. The trigger holds the parked item while CI is
// pending with time left, and offers it as work a run may start once CI is
// green or red, or ciTimeout passes, counted from when the wait began. The
// run that takes it up waits on, ends as a run that never parked would, and
// records the review phase again. The recipe and its document park and
// resume alike.

import {
  DEFAULT_LABELS,
  Implement,
  type Json,
  Phases,
  Resume,
  type WorkItem,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import resolveConflicts from "../packages/recipes/flows/resolve-conflicts.ts";
import { mayStart } from "../src/modules/runs/domain/run/work-item.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import { documentOf, loadFlow, RESOLVE_CONFLICTS_DOCUMENT } from "./compose-harness.ts";
import { effect } from "./effect-test.ts";
import {
  type EngineRun,
  type Fake,
  flowTriggered,
  HEAD,
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

const PR_ITEM = Phases.pullRequestItem(PULL);
const KEY = `pr-${PULL}-${HEAD.slice(0, 7)}`;

const work = item(KEY, { pullRequest: PULL, headRef: "auto/issue-3", baseRef: "main" });

const forms = [
  ["the recipe", Effect.succeed(resolveConflicts)],
  ["the document", loadFlow(documentOf(RESOLVE_CONFLICTS_DOCUMENT))],
] as const;

// The persona's own pull request, which GitHub says conflicts with its base,
// with its record at `phase`, as review left it.
const conflicting = (phase: string) => {
  const fake = makeFake("approve");
  fake.setLabels(PULL, []);
  fake.merge.state = "dirty";
  fake.recordPhase(PR_ITEM, phase);

  return fake;
};

// Whether the run waits on CI for its merge's first round, as one that ended
// at its park does.
const parkedOnCi = (run: EngineRun) =>
  Effect.map(listRunWaitsHandler({ runId: run.id, signal: Implement.CI_SETTLED }), ({ waits }) =>
    waits.some((wait) => wait.deferred === `${Implement.CI_SETTLED}:ci-1#resolve`),
  );

// The pull request's record: its phase and data.
const recordNow = (fake: Fake) =>
  Option.map(Option.fromUndefinedOr(fake.records().get(PR_ITEM)), (found) => ({
    phase: `${found.phase}`,
    data: Option.getOrElse(found.data, (): { readonly [key: string]: Json } => ({})),
  }));

const PENDING: Fake["merge"]["ci"] = { state: "pending", waitingOn: ["test"] };

for (const [form, loading] of forms) {
  const handle = Effect.map(loading, (flow) => flowHandle(repo, "resolve-conflicts", flow));

  const offeredItems = (fake: Fake) =>
    Effect.gen(function* () {
      return yield* flowTriggered(fake, yield* loading);
    }).pipe(Effect.orDie);

  // A first run on a conflict whose merge's CI stays pending, up to its park.
  const parkedRun = (fake: Fake) =>
    Effect.gen(function* () {
      fake.merge.afterPush = Option.some(PENDING);

      return yield* runUntil(yield* handle, fake, work, parkedOnCi);
    });

  // What a first run's park left on a pull request whose record was
  // `phase`: its record's data, to seed a later fake's record with.
  const parkedData = (phase: string) =>
    Effect.gen(function* () {
      const fake = conflicting(phase);
      yield* parkedRun(fake);

      return Option.getOrThrow(Option.map(recordNow(fake), (found) => found.data));
    });

  // A pull request whose merge a run pushed and parked on `ago`, then ended
  // at the park, over a record at `phase`, with CI on the merge now `ci`.
  const parkedEarlier = (ci: Fake["merge"]["ci"], ago: Duration.Duration, phase = "review-asked") =>
    Effect.gen(function* () {
      const data = yield* parkedData(phase);
      const since = DateTime.subtractDuration(yield* DateTime.now, ago);
      const fake = makeFake("approve");
      fake.setLabels(PULL, []);
      fake.merge.ci = ci;
      fake.git.pushes = 1;

      fake.recordPhase(PR_ITEM, "awaiting-conflict-ci", {
        at: DateTime.makeUnsafe(0),
        data: { ...data, since: DateTime.formatIso(since) },
      });

      return fake;
    });

  // An item that takes a parked wait up: the recipe's, keyed by the record,
  // or the document's, which carries where it resumes.
  const takesUp = (found: WorkItem) =>
    found.key.startsWith(`${PR_ITEM}-awaiting-conflict-ci`) ||
    Option.isSome(Resume.resumedAt(found));

  // The one item the trigger offers to take the parked wait up.
  const offeredWait = (fake: Fake) =>
    Effect.flatMap(offeredItems(fake), (items) =>
      Effect.fromOption(Arr.findFirst(items, takesUp)),
    ).pipe(Effect.orDie);

  // Takes the parked wait up, as the run its trigger starts.
  const resumed = (fake: Fake) =>
    Effect.gen(function* () {
      const taken: WorkItem = yield* offeredWait(fake);
      expect(mayStart(taken)).toBe(true);

      return yield* runToEnd(yield* handle, fake, taken);
    });

  describe(`resolve-conflicts' ${form}, on a merge whose CI is pending`, () => {
    effect(
      "records awaiting-conflict-ci over the review phase, with when the wait began, and ends at the park",
      () =>
        Effect.gen(function* () {
          const before = yield* DateTime.now;
          const fake = conflicting("review-asked");
          let parked = false;
          fake.merge.afterPush = Option.some(PENDING);

          const run = yield* runUntil(yield* handle, fake, work, (polled) =>
            Effect.map(parkedOnCi(polled), (found) => {
              parked = found;

              return found;
            }),
          );

          expect([run.status, parked]).toEqual(["running", true]);
          expect(fake.git.pushes).toBe(1);

          const recorded = Option.getOrThrow(recordNow(fake));
          expect(recorded.phase).toBe("awaiting-conflict-ci");
          expect(recorded.data.restore).toEqual({ phase: "review-asked" });

          const since = DateTime.make(`${recorded.data.since}`);

          expect(
            Option.exists(since, (began) => DateTime.isGreaterThanOrEqualTo(began, before)),
          ).toBe(true);

          // The document's record says where it resumes; the recipe's needn't.
          expect("resume" in recorded.data).toBe(form === "the document");
          // Nobody is asked to review while CI runs.
          expect(fake.people.requested).toEqual([]);
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "keeps the data of the record it parks over",
      () =>
        Effect.gen(function* () {
          const fake = makeFake("approve");
          fake.setLabels(PULL, []);
          fake.merge.state = "dirty";
          fake.recordPhase(PR_ITEM, "merge-held", { data: { key: "pr-7-approved" } });
          yield* parkedRun(fake);

          expect(Option.map(recordNow(fake), (found) => found.data.restore)).toEqual(
            Option.some({ phase: "merge-held", data: { key: "pr-7-approved" } }),
          );
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "is held, with why, while CI is still pending and the wait has time left",
      () =>
        Effect.gen(function* () {
          const fake = yield* parkedEarlier(PENDING, Duration.minutes(1));
          const held = yield* offeredWait(fake);

          expect(mayStart(held)).toBe(false);
          expect(held.held).toBe(`waits on CI for #${PULL}`);
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "once CI went green, is offered, ends as a run that never parked would, and records the review phase again",
      () =>
        Effect.gen(function* () {
          const fake = yield* parkedEarlier({ state: "green" }, Duration.minutes(5));
          const run = yield* resumed(fake);

          expect(run.status).toBe("done");
          expect(summaryOf(run)).toBe(`#${PULL}: merged main and resolved its conflicts`);
          // Nothing was merged or pushed again.
          expect(fake.requests).toEqual([]);
          expect(fake.git.pushes).toBe(1);
          expect(Option.map(recordNow(fake), (found) => found.phase)).toEqual(
            Option.some("review-asked"),
          );
          expect((yield* offeredItems(fake)).filter(takesUp)).toEqual([]);
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "over an approval, asks the approver again once CI went green",
      () =>
        Effect.gen(function* () {
          const fake = yield* parkedEarlier({ state: "green" }, Duration.minutes(5), "approved");
          fake.submitted.push({ author: "data-quail", state: "APPROVED", commitSha: HEAD });
          const run = yield* resumed(fake);

          expect(run.status).toBe("done");
          expect(summaryOf(run)).toBe(
            `#${PULL}: merged main, resolved its conflicts and asked data-quail to review again`,
          );
          expect(fake.people.requested).toEqual(["data-quail"]);
          expect(Option.map(recordNow(fake), (found) => found.phase)).toEqual(
            Option.some("review-asked-again"),
          );
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "once CI went red, is offered, and the run that takes it up fixes it, pushes and waits on",
      () =>
        Effect.gen(function* () {
          const fake = yield* parkedEarlier(
            { state: "red", failedChecks: ["test"] },
            Duration.minutes(5),
          );

          fake.merge.afterPush = Option.some({ state: "green" });
          const run = yield* resumed(fake);

          expect(run.status).toBe("done");
          expect(summaryOf(run)).toBe(`#${PULL}: merged main and resolved its conflicts`);
          // The fix's push.
          expect(fake.git.pushes).toBe(2);
          expect(fake.requests.at(-1)?.prompt).toContain(`CI failed on pull request #${PULL}`);
          expect(Option.map(recordNow(fake), (found) => found.phase)).toEqual(
            Option.some("review-asked"),
          );
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "still pending past ciTimeout, counted from when the wait began, goes to a person",
      () =>
        Effect.gen(function* () {
          const fake = yield* parkedEarlier(PENDING, Duration.hours(3));
          const run = yield* resumed(fake);

          expect(run.status).toBe("needs-human");
          expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.needsHuman);
          // With a person, from its review phase, which was back first.
          expect(Option.map(recordNow(fake), (found) => found.phase)).toEqual(
            Option.some("with-person"),
          );
          expect(Option.map(recordNow(fake), (found) => found.data.from)).toEqual(
            Option.some("review-asked"),
          );
        }),
      ENGINE_TIMEOUT,
    );
  });

  describe(`resolve-conflicts' ${form}, on a pull request with no record`, () => {
    effect(
      "has nothing to restore, so it polls rather than parks",
      () =>
        Effect.gen(function* () {
          const fake = makeFake("approve");
          fake.setLabels(PULL, []);
          fake.merge.state = "dirty";
          let polls = 0;
          let parked = false;
          fake.merge.afterPush = Option.some(PENDING);

          yield* runUntil(yield* handle, fake, work, (polled) =>
            Effect.gen(function* () {
              polls += 1;
              parked = yield* parkedOnCi(polled);

              return parked || polls >= 20;
            }),
          );

          expect(parked).toBe(false);
          // No wait is recorded; only a hand-off to a person, if it came to one.
          expect(Option.filter(recordNow(fake), (found) => found.phase !== "with-person")).toEqual(
            Option.none(),
          );
        }),
      ENGINE_TIMEOUT,
    );
  });
}

describe("a pull request parked on its merge's CI", () => {
  effect("is on a phase of its own, not address-review's awaiting-fix-ci", () =>
    Effect.sync(() => {
      const CONFLICT_CI = Phases.PHASES.pullRequest.awaitingConflictCi;
      const FIX_CI = Phases.PHASES.pullRequest.awaitingFixCi;
      expect(Phases.roundOf(FIX_CI, "awaiting-conflict-ci")).toEqual(Option.none());
      expect(Phases.roundOf(CONFLICT_CI, "awaiting-conflict-ci")).toEqual(Option.some(1));
      expect(Phases.roundOf(CONFLICT_CI, "awaiting-conflict-ci-2")).toEqual(Option.some(2));
      expect(Phases.inRound(CONFLICT_CI, 2)).toBe("awaiting-conflict-ci-2");
    }),
  );
});
