// Holding a merge while CI on the base branch is red (#147): an approved pull
// request on the automated path is held rather than going to a person. The
// hold is the pull request's merge-held record, and the park ends the run
// (ADR 23, decision 2); once the base is green again, the flow's trigger
// offers it from the record (PullRequest.heldMerges) and a new run merges.
// A follow-up's fix merges while the base is red, and with the setting off
// nothing changes.

import {
  type CiState,
  defineFlow,
  Implement,
  type Issue,
  NeedsHuman,
  PullRequest,
  Settings,
  StepFailed,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { mayStart } from "../src/modules/runs/domain/run/work-item.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { effect } from "./effect-test.ts";
import {
  type Fake,
  follow,
  HEAD,
  item,
  makeFake,
  onEngine,
  PULL,
  repo,
  runToEnd,
  summaryOf,
  takeUp,
  triggered,
} from "./sdk-fakes.ts";

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
  fake.recordReview({ sha: HEAD, round: 1, verdict: "approve" });
  fake.setLabels(PULL, [SHIP]);
  fake.merge.baseCi = Option.some(base);

  return fake;
};

const HOLDING = { holdMergesOnBrokenBase: true };

// What heldMerges offers, with merges held: the held merges of this flow's
// runs, from their records, as the flow's trigger would.
const offered = (fake: Fake) =>
  triggered(
    fake,
    Effect.provideService(
      PullRequest.heldMerges(() => true),
      Settings.FlowSettings,
      { input: HOLDING },
    ),
  ).pipe(Effect.orDie);

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
    "holds the merge in its record and ends the run at the park, rather than merging or handing it to a person, and a new run merges once the base is green",
    () =>
      Effect.gen(function* () {
        const fake = approved(RED);

        const { atPark, finished, found, parked, stillRed } = yield* onEngine(
          holding,
          fake,
          Effect.gen(function* () {
            const ended = yield* follow(holding, WORK);
            const state = { merges: [...fake.merge.requests], labels: fake.labelsOf(PULL) };
            // Still red: nothing offers it, so no run takes it up.
            const red = yield* takeUp(holding, yield* offered(fake));
            fake.merge.baseCi = Option.some(GREEN);
            const green = yield* offered(fake);

            return {
              parked: ended,
              atPark: state,
              stillRed: red,
              found: green,
              finished: yield* takeUp(holding, green),
            };
          }),
        );

        // The park ended the run; nothing was merged or handed to a person.
        expect(parked.status).toBe("ended-at-park");
        expect(atPark).toEqual({ merges: [], labels: [SHIP] });
        expect(
          fake.comments.filter((comment) =>
            comment.body.startsWith("Holding the merge: CI is failing on `main`."),
          ),
        ).toHaveLength(1);
        expect(stillRed).toEqual(Option.none());
        // Green: work a run may start, from the pull request's merge-held record.
        expect(found.map((work) => [work.key, work.signals, mayStart(work)])).toEqual([
          ["hold", [PullRequest.BASE_GREEN], true],
        ]);

        const merged = yield* Effect.fromOption(finished).pipe(Effect.orDie);
        expect(merged.status).toBe("done");
        expect(merged.id).not.toBe(parked.id);
        expect(summaryOf(merged)).toBe(`#${PULL} merged (squash) as \`merged9\``);
        expect(fake.merge.requests).toEqual([{ method: "squash", sha: HEAD }]);
        expect(fake.labelsOf(PULL)).toEqual([SHIP]);
      }),
  );

  effect("holds the merge with the run's record, naming the work item that holds it", () =>
    Effect.gen(function* () {
      const fake = approved(RED);
      const parked = yield* runToEnd(holding, fake, WORK);

      expect(parked.status).toBe("ended-at-park");
      expect(fake.merge.requests).toEqual([]);
      expect(fake.labelsOf(PULL)).toEqual([SHIP]);
      expect(fake.phases()[`pr-${PULL}`]).toBe("merge-held");
      expect(
        Option.flatMap(Option.fromUndefinedOr(fake.records().get(`pr-${PULL}`)), (record) =>
          Option.map(record.data, (data) => data.key),
        ),
      ).toEqual(Option.some("hold"));
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

  effect(
    "hands the pull request to a person when a new run takes the hold up still red past mergeHoldTimeout",
    () =>
      Effect.gen(function* () {
        const fake = approved(RED);

        const capped = withSettings({
          holdMergesOnBrokenBase: true,
          mergeHoldTimeout: "10 minutes",
        });

        const { finished, found, parked } = yield* onEngine(
          capped,
          fake,
          Effect.gen(function* () {
            const ended = yield* follow(capped, WORK);

            // The hold began past the cap: its record says it began an hour ago.
            const record = yield* Effect.fromOption(
              Option.fromUndefinedOr(fake.records().get(`pr-${PULL}`)),
            ).pipe(Effect.orDie);

            fake.recordPhase(`pr-${PULL}`, record.phase, {
              at: DateTime.subtract(record.at, { hours: 1 }),
              data: Option.getOrElse(record.data, () => ({})),
            });

            // Still red, but due: heldMerges offers the hold without a signal.
            const due = yield* triggered(
              fake,
              Effect.provideService(
                PullRequest.heldMerges(() => true),
                Settings.FlowSettings,
                {
                  input: { ...HOLDING, mergeHoldTimeout: "10 minutes" },
                },
              ),
            ).pipe(Effect.orDie);

            return { parked: ended, found: due, finished: yield* takeUp(capped, due) };
          }),
        );

        expect(parked.status).toBe("ended-at-park");
        expect(
          found.map((work) => [work.key, Option.fromUndefinedOr(work.signals), mayStart(work)]),
        ).toEqual([["hold", Option.none(), true]]);

        const handed = yield* Effect.fromOption(finished).pipe(Effect.orDie);
        expect(handed.status).toBe("needs-human");
        expect(summaryOf(handed)).toContain("CI on main stayed red for 10m");
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

        const { atPark, finished, parked } = yield* onEngine(
          holding,
          fake,
          Effect.gen(function* () {
            const ended = yield* follow(holding, work);
            const merges = [...fake.merge.requests];
            const phase = fake.phases()[`pr-${PULL}`];

            return {
              parked: ended,
              atPark: { merges, phase },
              finished: yield* takeUp(holding, yield* offered(fake)),
            };
          }),
        );

        // Held again, not handed to a person: the run ended at its park, with
        // the hold in its record and nothing merged.
        expect(parked.status).toBe("ended-at-park");
        expect(atPark).toEqual({ merges: [], phase: "merge-held" });

        const merged = yield* Effect.fromOption(finished).pipe(Effect.orDie);
        expect(merged.status).toBe("done");
        expect(summaryOf(merged)).toBe(`#${PULL} merged (squash) as \`merged9\``);
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
