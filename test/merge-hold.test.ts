// Holding a merge while CI on the base branch is red (#147): an approved pull
// request on the automated path waits, parked, rather than going to a
// person, and merges once the base is green again. A follow-up's fix merges
// while the base is red, and with the setting off nothing changes.

import {
  type CiState,
  defineFlow,
  Implement,
  type Issue,
  NeedsHuman,
  PullRequest,
  reviewMarker,
  Settings,
  StepFailed,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import { effect } from "./effect-test.ts";
import {
  deliverSignals,
  type EngineRun,
  type Fake,
  HEAD,
  item,
  makeFake,
  PULL,
  repo,
  runToEnd,
  runUntil,
  summaryOf,
  triggered,
} from "./sdk-fakes.ts";

const IMPLICIT = Option.none<string>();
const SHIP = "auto:ship";
const WORK = item("hold");

const RED: CiState = { state: "red", failedChecks: ["test"] };
const GREEN: CiState = { state: "green" };

const FOLLOW_UP = `CI went red. <!-- chernabog-post-merge {"sha":"merge5678","pullRequest":12} -->`;

// As the review recipes merge an approval: hold while the base is red, then
// merge; a refusal is the flow's, here a person's.
const flow = defineFlow({
  trigger: Effect.succeed([]),
  workflow: (work) =>
    Effect.gen(function* () {
      if (work.key === "merge-holding") {
        return yield* PullRequest.mergeHolding(PULL, { method: "squash" });
      }

      if (work.key === "merge-polling") {
        return yield* PullRequest.mergeHolding(PULL, { method: "squash", poll: true });
      }

      if (work.key !== "merge-only") {
        yield* PullRequest.holdWhileBaseRed(PULL);
      }

      return yield* PullRequest.merge(PULL, { method: "squash" });
    }).pipe(
      Effect.catchTags({
        MergeRefused: (refused) => Effect.fail(new NeedsHuman({ reason: refused.message })),
        PullRequestClosed: (closed) =>
          Effect.fail(new StepFailed({ step: "merge", message: closed.message })),
        NotFound: (gone) => Effect.fail(new StepFailed({ step: "merge", message: gone.message })),
      }),
    ),
});

// The flow in a repo whose config.yaml sets these for every flow.
const withSettings = (shared: Settings.FlowSettings["Service"]["input"]) =>
  flowHandle(
    {
      ...repo,
      personas: Arr.map(repo.personas, (persona) => ({ ...persona, shared })),
    },
    "demo",
    flow,
  );

const holding = withSettings({ holdMergesOnBrokenBase: true });
const off = withSettings({});

// An approved auto:ship pull request with green checks on its head.
const approved = (base: CiState) => {
  const fake = makeFake("approve");
  fake.comment(reviewMarker.write({ sha: HEAD, round: 1, verdict: "approve" }));
  fake.setLabels(PULL, [SHIP]);
  fake.merge.baseCi = Option.some(base);

  return fake;
};

const HOLDING = { holdMergesOnBrokenBase: true };

// What baseTurnedGreen reports, with merges held.
const woken = (fake: Fake) =>
  triggered(
    fake,
    Effect.provideService(PullRequest.baseTurnedGreen, Settings.FlowSettings, { input: HOLDING }),
  ).pipe(Effect.orDie);

const parkedOnBase = (run: EngineRun) =>
  listRunWaitsHandler({ runId: run.id, signal: PullRequest.BASE_GREEN }).pipe(
    Effect.map(({ waits }) => waits.length > 0),
    Effect.orDie,
  );

describe("holding a merge on a red base branch", () => {
  effect("with the setting off, merges an approved pull request while the base is red", () =>
    Effect.gen(function* () {
      const fake = approved(RED);
      const finished = yield* runToEnd(off, fake, WORK);
      expect(finished.status).toBe("done");
      expect(fake.merge.requests).toEqual([{ method: "squash", sha: HEAD }]);
    }),
  );

  effect(
    "parks the run, with its record, rather than merging or handing it to a person, and merges once the base is green",
    () =>
      Effect.gen(function* () {
        const fake = approved(RED);
        let held = false;

        const finished = yield* runUntil(holding, fake, WORK, (run) =>
          Effect.gen(function* () {
            if (run.status !== "running") {
              return true;
            }

            if (!(yield* parkedOnBase(run))) {
              return false;
            }

            if (!held) {
              held = true;
              expect(fake.merge.requests).toEqual([]);
              expect(fake.labelsOf(PULL)).toEqual([SHIP]);
              expect(
                fake.comments.some((found) =>
                  found.body.startsWith("Holding the merge: CI is failing on `main`."),
                ),
              ).toBe(true);
              // The hold is the pull request's record, naming the work item that holds it.
              expect(fake.phases()[`pr-${PULL}`]).toBe("merge-held");
              expect(
                Option.flatMap(Option.fromUndefinedOr(fake.records().get(`pr-${PULL}`)), (record) =>
                  Option.map(record.data, (data) => data.key),
                ),
              ).toEqual(Option.some("hold"));
              // Still red: nothing wakes it.
              expect(yield* woken(fake)).toEqual([]);
              fake.merge.baseCi = Option.some(GREEN);
            }

            const found = yield* woken(fake);
            expect(found.map((work) => [work.key, work.signals, work.wakeOnly])).toEqual([
              ["hold", [PullRequest.BASE_GREEN], true],
            ]);
            yield* deliverSignals(holding, IMPLICIT, found);

            return false;
          }),
        );

        expect(held).toBe(true);
        expect(finished.status).toBe("done");
        expect(summaryOf(finished)).toBe(`#${PULL} merged (squash) as \`merged9\``);
        expect(fake.merge.requests).toEqual([{ method: "squash", sha: HEAD }]);
      }),
  );

  effect("a hold that polls says so once and looks at the base again, without parking", () =>
    Effect.gen(function* () {
      const fake = approved(RED);

      const holdsSaid = () =>
        fake.comments.filter((found) => found.body.startsWith("Holding the merge:")).length;

      let parked = Option.none<boolean>();
      let since = 0;

      // A few polls after it said so, by when a park would have registered.
      const run = yield* runUntil(holding, fake, item("merge-polling"), (polled) =>
        Effect.gen(function* () {
          if (holdsSaid() === 0) {
            return false;
          }

          since += 1;
          parked = Option.some(yield* parkedOnBase(polled));

          return since >= 5;
        }),
      );

      expect(run.status).toBe("running");
      expect(parked).toEqual(Option.some(false));
      expect(holdsSaid()).toBe(1);
      expect(fake.phases()[`pr-${PULL}`]).toBe("merge-held");
      expect(fake.merge.requests).toEqual([]);
    }),
  );

  effect("merges at once while the base is green, or has no completed run yet", () =>
    Effect.gen(function* () {
      const green = approved(GREEN);
      expect((yield* runToEnd(holding, green, WORK)).status).toBe("done");
      expect(green.merge.requests).toHaveLength(1);

      const none = approved(GREEN);
      none.merge.baseCi = Option.some({ state: "pending", waitingOn: [] });
      expect((yield* runToEnd(holding, none, WORK)).status).toBe("done");
      expect(none.merge.requests).toHaveLength(1);
    }),
  );

  effect("merges a post-merge follow-up's fix while the base is red", () =>
    Effect.gen(function* () {
      const fake = approved(RED);
      fake.issueText.body = FOLLOW_UP;
      const finished = yield* runToEnd(holding, fake, WORK);
      expect(finished.status).toBe("done");
      expect(fake.merge.requests).toEqual([{ method: "squash", sha: HEAD }]);
    }),
  );

  effect("hands the pull request to a person when woken still red past mergeHoldTimeout", () =>
    Effect.gen(function* () {
      const fake = approved(RED);

      const capped = withSettings({
        holdMergesOnBrokenBase: true,
        mergeHoldTimeout: "10 millis",
      });

      // Woken while the base is still red, as a flapping base can, a poll
      // (25ms) after it parked, once the cap has passed.
      let polls = 0;

      const finished = yield* runUntil(capped, fake, WORK, (run) =>
        Effect.gen(function* () {
          if (run.status !== "running") {
            return true;
          }

          if (yield* parkedOnBase(run)) {
            polls += 1;
          }

          if (polls > 1) {
            yield* deliverSignals(capped, IMPLICIT, [
              { ...WORK, signals: [PullRequest.BASE_GREEN], wakeOnly: true },
            ]);
          }

          return false;
        }),
      );

      expect(finished.status).toBe("needs-human");
      expect(summaryOf(finished)).toContain("CI on main stayed red for 10ms");
      expect(fake.merge.requests).toEqual([]);
    }),
  );

  effect(
    "PullRequest.merge itself refuses while the base is red, so no caller merges into it",
    () =>
      Effect.gen(function* () {
        const fake = approved(RED);
        const finished = yield* runToEnd(holding, fake, item("merge-only"));
        expect(finished.status).toBe("needs-human");
        expect(summaryOf(finished)).toContain("holding merge: CI failing on main");
        expect(fake.merge.requests).toEqual([]);
      }),
  );

  effect(
    "mergeHolding holds again, rather than handing over, when the base turns red between the hold's look and the merge's",
    () =>
      Effect.gen(function* () {
        const fake = approved(GREEN);
        // The hold sees it green, merge sees it red, and the next hold red again.
        fake.merge.baseCiReads.push(GREEN, RED, RED);
        const work = item("merge-holding");
        let held = false;

        const finished = yield* runUntil(holding, fake, work, (run) =>
          Effect.gen(function* () {
            if (run.status !== "running") {
              return true;
            }

            if (yield* parkedOnBase(run)) {
              held = true;
              expect(fake.merge.requests).toEqual([]);
              yield* deliverSignals(holding, IMPLICIT, yield* woken(fake));
            }

            return false;
          }),
        );

        expect(held).toBe(true);
        expect(finished.status).toBe("done");
        expect(summaryOf(finished)).toBe(`#${PULL} merged (squash) as \`merged9\``);
        expect(fake.merge.requests).toEqual([{ method: "squash", sha: HEAD }]);
      }),
  );
});

describe("Implement.followUpsFirst", () => {
  const issue = (number: number, body = ""): Issue => ({
    number,
    title: `#${number}`,
    body,
    url: `https://github.com/dataquail/demo/issues/${number}`,
    createdAt: "2026-10-20T00:00:00Z",
    labels: [],
    assignees: [],
  });

  effect("puts the post-merge recipe's follow-ups first, each part in the order given", () =>
    Effect.sync(() => {
      const ordered = Implement.followUpsFirst([
        issue(1),
        issue(2, FOLLOW_UP),
        issue(3),
        issue(4, FOLLOW_UP),
      ]);

      expect(ordered.map((found) => found.number)).toEqual([2, 4, 1, 3]);
    }),
  );
});
