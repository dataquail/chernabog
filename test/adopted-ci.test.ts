// implement's wait for CI on a pull request it adopted parks (audit W5, ADR
// 0021 decision 4) on a phase of its own, the issue's awaiting-adopted-ci,
// not the awaiting-ci of its wait on one it opened: the phase alone says
// where the run that takes it up starts. The record keeps the adopted pull
// request, since it isn't on the issue's branch. The trigger holds the
// issue while CI is pending with time left and offers it as work a run may
// start once CI is green or red, or ciTimeout passes, counted from when the
// wait began. The run that takes it up waits on and hands the pull request
// off as an adopted one, as a run that never parked would. The recipe and
// its document (ci.waitPreparing at adoptedCi) park and resume alike.

import {
  claimMarker,
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

import implement from "../packages/recipes/flows/implement.ts";
import { mayStart } from "../src/modules/runs/domain/run/work-item.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import { documentOf, IMPLEMENT_DOCUMENT, loadFlow } from "./compose-harness.ts";
import { effect } from "./effect-test.ts";
import {
  type EngineRun,
  type Fake,
  flowTriggered,
  ISSUE,
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

const ISSUE_ITEM = Phases.issueItem(ISSUE);
const POOL = { reviewers: ["zach", "data-quail"] };
const BRANCH = "zach/fix-it";
const PULL_URL = `https://github.com/dataquail/demo/pull/${PULL}`;

const forms = [
  ["the recipe", Effect.succeed(implement)],
  ["the document", loadFlow(documentOf(IMPLEMENT_DOCUMENT))],
] as const;

const PENDING: Fake["merge"]["ci"] = { state: "pending", waitingOn: ["test"] };

// A person's pull request, ready for review, already closes the issue.
const withPull = (fake: Fake) => {
  fake.setLabels(PULL, []);
  fake.git.opened = true;
  fake.authored.headRef = BRANCH;
  fake.authored.author = "zach";
  fake.authored.draft = false;
  fake.closing.push({
    number: PULL,
    url: PULL_URL,
    state: "OPEN",
    isDraft: false,
    headRefName: BRANCH,
    baseRefName: "main",
    isCrossRepository: false,
  });

  return fake;
};

// The issue queued, with that pull request closing it.
const queued = () => {
  const fake = withPull(makeFake("approve", POOL));
  fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);

  return fake;
};

const work = item(`issue-${ISSUE}`, { issue: ISSUE });

// Whether the run waits on its adopted pull request's CI, as one that ended
// at its park does.
const parkedOnCi = (run: EngineRun) =>
  Effect.map(listRunWaitsHandler({ runId: run.id, signal: Implement.CI_SETTLED }), ({ waits }) =>
    waits.some((wait) => wait.deferred === `${Implement.CI_SETTLED}:ci-1`),
  );

// The issue's record: its phase and data.
const recordNow = (fake: Fake) =>
  Option.map(Option.fromUndefinedOr(fake.records().get(ISSUE_ITEM)), (found) => ({
    phase: `${found.phase}`,
    data: Option.getOrElse(found.data, (): { readonly [key: string]: Json } => ({})),
  }));

for (const [form, loading] of forms) {
  const handle = Effect.map(loading, (flow) => flowHandle(repo, "implement", flow));

  const offeredItems = (fake: Fake) =>
    Effect.gen(function* () {
      return yield* flowTriggered(fake, yield* loading);
    }).pipe(Effect.orDie);

  // What a first run's park left: its record's data, to seed a later fake with.
  const parkedData = Effect.gen(function* () {
    const fake = queued();
    fake.merge.ci = PENDING;
    yield* runUntil(yield* handle, fake, work, parkedOnCi);

    return Option.getOrThrow(Option.map(recordNow(fake), (found) => found.data));
  });

  // An issue whose run adopted the pull request, parked on its CI `ago` and
  // ended at the park, with CI on the pull request now `ci`.
  const parkedEarlier = (ci: Fake["merge"]["ci"], ago: Duration.Duration) =>
    Effect.gen(function* () {
      const data = yield* parkedData;
      const since = DateTime.subtractDuration(yield* DateTime.now, ago);
      const fake = withPull(makeFake("approve", POOL));
      fake.setLabels(ISSUE, [DEFAULT_LABELS.inProgress]);
      fake.merge.ci = ci;
      fake.comment(
        claimMarker.write({
          runId: "an-earlier-run",
          claimedAt: "2026-10-28T00:00:00Z",
          branch: BRANCH,
          base: "main",
          ref: true,
          adopted: { number: PULL, url: PULL_URL, draft: false },
        }),
      );

      fake.recordPhase(ISSUE_ITEM, "awaiting-adopted-ci", {
        at: DateTime.makeUnsafe(0),
        data: { ...data, since: DateTime.formatIso(since) },
      });

      return fake;
    });

  // An item that takes the parked wait up: the recipe's carries the wait,
  // the document's where it resumes.
  const takesUp = (found: WorkItem) =>
    Option.isSome(Implement.resumingCi(found)) || Option.isSome(Resume.resumedAt(found));

  const offeredWait = (fake: Fake) =>
    Effect.flatMap(offeredItems(fake), (items) =>
      Effect.fromOption(Arr.findFirst(items, takesUp)),
    ).pipe(Effect.orDie);

  // Takes the parked wait up, as the run its trigger starts.
  const resumed = (fake: Fake) =>
    Effect.gen(function* () {
      const taken = yield* offeredWait(fake);
      expect(mayStart(taken)).toBe(true);

      return yield* runToEnd(yield* handle, fake, taken);
    });

  // It was handed off as an adopted pull request: no agent implemented
  // anything, a reviewer was asked, and the issue was told why.
  const handedOffAdopted = (fake: Fake) => {
    expect(fake.requests).toEqual([]);
    expect(fake.people.requested).toHaveLength(1);
    expect(
      fake.comments.some((comment) => comment.body.includes("already closed this issue")),
    ).toBe(true);
  };

  describe(`implement's ${form}, on an adopted pull request whose CI is pending`, () => {
    effect(
      "records awaiting-adopted-ci on the issue with the adopted pull request and when the wait began, and ends at the park",
      () =>
        Effect.gen(function* () {
          const before = yield* DateTime.now;
          const fake = queued();
          fake.merge.ci = PENDING;
          let parked = false;

          const run = yield* runUntil(yield* handle, fake, work, (polled) =>
            Effect.map(parkedOnCi(polled), (found) => {
              parked = found;

              return found;
            }),
          );

          expect([run.status, parked]).toEqual(["running", true]);

          const recorded = Option.getOrThrow(recordNow(fake));
          expect(recorded.phase).toBe("awaiting-adopted-ci");
          expect(recorded.data.pullRequest).toBe(PULL);

          expect(
            Option.exists(DateTime.make(`${recorded.data.since}`), (began) =>
              DateTime.isGreaterThanOrEqualTo(began, before),
            ),
          ).toBe(true);

          expect("resume" in recorded.data).toBe(form === "the document");
          // Nothing was handed off yet.
          expect(fake.people.requested).toEqual([]);
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
      "once CI went green, is offered, and the run that takes it up hands it off as adopted",
      () =>
        Effect.gen(function* () {
          const fake = yield* parkedEarlier({ state: "green" }, Duration.minutes(5));
          const run = yield* resumed(fake);

          expect(run.status).toBe("done");
          expect(summaryOf(run)).toBe(`#${ISSUE}: ${PULL_URL} is ready for review`);
          handedOffAdopted(fake);
          expect((yield* offeredItems(fake)).filter(takesUp)).toEqual([]);
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "once CI went red, is offered, and the run that takes it up fixes it, then hands it off",
      () =>
        Effect.gen(function* () {
          const fake = yield* parkedEarlier(
            { state: "red", failedChecks: ["test"] },
            Duration.minutes(5),
          );

          fake.merge.afterPush = Option.some({ state: "green" });
          const run = yield* resumed(fake);

          expect(run.status).toBe("done");
          expect(fake.git.pushes).toBe(1);
          expect(fake.requests.at(-1)?.prompt).toContain(`CI failed on pull request #${PULL}`);
          expect(fake.people.requested).toHaveLength(1);
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
          expect(fake.labelsOf(ISSUE)).toContain(DEFAULT_LABELS.needsHuman);
          expect(fake.people.requested).toEqual([]);
        }),
      ENGINE_TIMEOUT,
    );
  });
}
