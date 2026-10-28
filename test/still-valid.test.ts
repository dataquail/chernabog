// The SDK's stillValid checks against an in-memory GitHub: an issue's run is
// gone once the issue closes, another run holds its claim, or the pull
// request it opened is closed or merged; a pull request's run once the pull
// request closes or merges. A read that fails is not Gone.

import {
  Claims,
  GitHub,
  GitHubError,
  Implement,
  Plan,
  Review,
  Run,
  type RunInfo,
  type Validity,
  type WorkItem,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { effect } from "./effect-test.ts";
import { type Fake, ISSUE, item, makeFake, PULL } from "./sdk-fakes.ts";

const issueWork = item(`issue-${ISSUE}`, { issue: ISSUE });
const pullWork = item(`pr-${PULL}`, { pullRequest: PULL, headRef: "auto/issue-3", agentWritten: true });

const RUN: RunInfo = { flow: "implement", runId: "this-run", executionId: "e", item: issueWork };

// The claim ref on `claim` names `runId`'s run.
const heldBy = (fake: Fake, claim: string, runId: string) => {
  fake.commits.set(`held-${runId}`, Claims.messageOf({
    runId,
    persona: "data-quail",
    flow: "implement",
    claimedAt: "2026-10-26T14:00:00Z",
    withPerson: false,
  }));
  fake.refs.set(Claims.refFor(claim), `held-${runId}`);
};

const check = (
  fake: Fake,
  stillValid: (work: WorkItem) => Effect.Effect<Validity, unknown, GitHub | Run>,
  work: WorkItem,
  run: Partial<RunInfo> = {},
) =>
  Effect.provide(
    stillValid(work),
    Layer.mergeAll(fake.services, Layer.succeed(Run, Run.of({ ...RUN, item: work, ...run }))),
  );

describe("Implement.stillValid", () => {
  effect("is valid while the issue is open and its claim is this run's or nobody's", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      expect(yield* check(fake, Implement.stillValid, issueWork)).toEqual({ valid: true });

      heldBy(fake, Claims.issue(ISSUE), "this-run");
      expect(yield* check(fake, Implement.stillValid, issueWork)).toEqual({ valid: true });
    }),
  );

  effect("is gone once the issue is closed", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.states.issue = "closed";

      expect(yield* check(fake, Implement.stillValid, issueWork)).toEqual({
        valid: false,
        reason: `#${ISSUE} was closed`,
      });
    }),
  );

  effect("is gone once another run holds the issue's claim", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      heldBy(fake, Claims.issue(ISSUE), "another-run");

      expect(yield* check(fake, Implement.stillValid, issueWork)).toEqual({
        valid: false,
        reason: `run another-run of implement holds the claim on #${ISSUE}`,
      });
    }),
  );

  effect("is gone once the pull request the run opened is closed or merged", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      expect(
        yield* check(fake, Implement.stillValid, issueWork, { pullRequest: PULL }),
      ).toEqual({ valid: true });

      fake.states.pull = "merged";

      expect(
        yield* check(fake, Implement.stillValid, issueWork, { pullRequest: PULL }),
      ).toEqual({ valid: false, reason: `#${PULL} was merged` });
      // Plan opens no pull request, so it never asks.
      expect(yield* check(fake, Plan.stillValid, issueWork, { pullRequest: PULL })).toEqual({
        valid: true,
      });
    }),
  );

  effect("fails, rather than says Gone, when GitHub can't be read", () =>
    Effect.gen(function* () {
      const failing = Layer.mock(GitHub)({
        issue: () => Effect.fail(new GitHubError({ message: "rate limited" })),
      });

      const failure = yield* Effect.flip(
        Effect.provide(
          Implement.stillValid(issueWork),
          Layer.mergeAll(failing, Layer.succeed(Run, Run.of(RUN))),
        ),
      );

      expect([failure._tag, failure.message]).toEqual(["StepFailed", "rate limited"]);
    }),
  );
});

describe("Plan.stillValid", () => {
  effect("is gone once the spec is closed", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.states.issue = "closed";

      expect(yield* check(fake, Plan.stillValid, issueWork)).toEqual({
        valid: false,
        reason: `#${ISSUE} was closed`,
      });
    }),
  );
});

describe("Review.stillValid", () => {
  effect("is valid while the pull request is open, and gone once it's closed", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      expect(yield* check(fake, Review.stillValid, pullWork)).toEqual({ valid: true });

      fake.states.pull = "closed";

      expect(yield* check(fake, Review.stillValid, pullWork)).toEqual({
        valid: false,
        reason: `#${PULL} was closed`,
      });
    }),
  );

  effect("is gone once another run holds the pull request's claim", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      heldBy(fake, Claims.pullRequest(PULL), "another-run");

      expect(yield* check(fake, Review.stillValid, pullWork)).toEqual({
        valid: false,
        reason: `run another-run of implement holds the claim on #${PULL}`,
      });
    }),
  );
});
