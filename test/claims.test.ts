// Claims as refs of their own, apart from the work branch, against an
// in-memory GitHub: who holds an issue or a pull request, letting go when the
// run ends, adopting a branch nobody claims, and the claims runs of an earlier
// version hold by their branch and comments alone.

import {
  awaitSignal,
  claimMarker,
  Claims,
  DEFAULT_LABELS,
  defineFlow,
  Implement,
  PullRequest,
  Review,
  StepFailed,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import humanInitiated from "../packages/recipes/flows/human-initiated.ts";
import implement from "../packages/recipes/flows/implement.ts";
import reviewFlow from "../packages/recipes/flows/review.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import { effect } from "./effect-test.ts";
import {
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

const implementing = flowHandle(repo, "implement", implement);
const starting = flowHandle(repo, "human-initiated", humanInitiated);
const work = item(`issue-${ISSUE}`, { issue: ISSUE });
const POOL = { reviewers: ["zach", "data-quail"] };
const ISSUE_REF = Claims.refFor(Claims.issue(ISSUE));
const PULL_REF = Claims.refFor(Claims.pullRequest(PULL));

const OTHER: Claims.Holder = {
  runId: "another-run",
  persona: "data-quail",
  flow: "implement",
  claimedAt: "2026-10-26T14:00:00Z",
  withPerson: false,
};

// The claim ref names a run of another machine's.
const heldBy = (fake: Fake, ref: string, holder: Claims.Holder = OTHER) => {
  fake.commits.set("held0000", Claims.messageOf(holder));
  fake.refs.set(ref, "held0000");
};

const holderOf = (fake: Fake, ref: string) =>
  Option.flatMap(Option.fromUndefinedOr(fake.refs.get(ref)), (sha) =>
    Claims.holderOf(fake.commits.get(sha) ?? ""),
  );

// Every claim this fake was asked to commit, oldest first.
const claimsMade = (fake: Fake) =>
  [...fake.commits.values()].flatMap((message) => Option.toArray(Claims.holderOf(message)));

// An unattended run of an earlier version's claim: its marker names no claim ref.
const legacyMarker = (fake: Fake) => {
  fake.comment(
    claimMarker.write({
      runId: "an-earlier-version",
      claimedAt: "2026-10-20T00:00:00Z",
      branch: `auto/issue-${ISSUE}`,
    }),
  );
};

describe("a claim commit", () => {
  effect("records whose run holds the claim, and reads back", () =>
    Effect.sync(() => {
      const message = Claims.messageOf({ ...OTHER, withPerson: true });
      expect(message).toBe(
        [
          "chernabog claim",
          "",
          "Run: another-run",
          "Persona: data-quail",
          "Flow: implement",
          "Claimed-At: 2026-10-26T14:00:00Z",
          "With-Person: true",
        ].join("\n"),
      );
      expect(Claims.holderOf(message)).toEqual(Option.some({ ...OTHER, withPerson: true }));
      expect(Claims.holderOf(Claims.messageOf(OTHER))).toEqual(Option.some(OTHER));
      expect(Claims.holderOf("Merge branch main")).toEqual(Option.none());
    }),
  );
});

describe("claiming an issue", () => {
  effect(
    "claimed again by the same run for a later attempt, takes the base it is given now and takes the queue label off again",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve", POOL);
        fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);

        // The first attempt is stacked on another task's branch; by the
        // second, that branch has merged, and the task's base is main.
        const twice = defineFlow({
          trigger: Effect.succeed([]),
          workflow: () =>
            Effect.gen(function* () {
              const first = yield* Implement.claim(ISSUE, { base: "auto/issue-9", id: "task-1" });
              fake.existing.branch = true;
              fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
              const second = yield* Implement.claim(ISSUE, { base: "main", id: "task-1-2" });

              return `${first.base ?? ""} then ${second.base ?? ""}`;
            }),
        });

        const finished = yield* runToEnd(flowHandle(repo, "twice", twice), fake, work);
        expect(summaryOf(finished)).toBe("auto/issue-9 then main");
        expect(fake.labelsOf(ISSUE)).not.toContain(DEFAULT_LABELS.eligible);
      }),
  );

  effect("takes the claim ref, and lets it go when the run ends, keeping the pull request", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve", POOL);
      fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
      const finished = yield* runToEnd(implementing, fake, work);
      expect(finished.status).toBe("done");

      expect(claimsMade(fake).map((claim) => [claim.runId, claim.flow, claim.persona])).toEqual([
        [finished.id, "implement", "chernabog-bot"],
      ]);
      expect(fake.refs.has(ISSUE_REF)).toBe(false);
      expect(fake.git.opened).toBe(true);
      // The pull request it opened is the run's subject.
      expect(finished.subjects).toEqual([`pr-${PULL}`]);

      // The comment a person reads says the claim is a ref.
      expect(
        fake.comments.some((comment) =>
          Option.exists(claimMarker.read(comment.body), (claim) => claim.ref === true),
        ),
      ).toBe(true);
    }),
  );

  effect("skips an issue whose claim ref another run holds, and leaves the claim to it", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve", POOL);
      heldBy(fake, ISSUE_REF);
      const skipped = yield* runToEnd(implementing, fake, work);
      expect(skipped.status).toBe("skipped");
      expect(summaryOf(skipped)).toBe(
        `#${ISSUE} is already claimed (run another-run of implement holds ${ISSUE_REF})`,
      );
      expect(holderOf(fake, ISSUE_REF)).toEqual(Option.some(OTHER));
      expect(fake.requests).toEqual([]);
    }),
  );

  effect("adopts a branch nobody claims, as the work to go on with", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve", POOL);
      fake.existing.branch = true;
      const finished = yield* runToEnd(implementing, fake, work);
      expect(finished.status).toBe("done");
      expect(fake.requests).toHaveLength(1);
      expect(fake.refs.has(ISSUE_REF)).toBe(false);
    }),
  );

  effect(
    "while runs of an earlier version hold issues by their branch, leaves such a one to them",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve", POOL);
        fake.existing.branch = true;
        legacyMarker(fake);
        const skipped = yield* runToEnd(implementing, fake, work);
        expect(skipped.status).toBe("skipped");
        expect(summaryOf(skipped)).toBe(
          `#${ISSUE} is already claimed (auto/issue-${ISSUE} exists)`,
        );
        // The claim ref it took to find out goes back.
        expect(fake.refs.has(ISSUE_REF)).toBe(false);
        expect(fake.requests).toEqual([]);
      }),
  );
});

describe("claiming an issue with a person", () => {
  effect("a session the person closes lets the claim go, so the next start takes it up again", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve", POOL);
      fake.author.closes = true;
      expect((yield* runToEnd(starting, fake, work)).status).toBe("failed");
      expect(claimsMade(fake).map((claim) => claim.withPerson)).toEqual([true]);
      expect(fake.refs.has(ISSUE_REF)).toBe(false);
      expect(fake.labelsOf(ISSUE)).toEqual([DEFAULT_LABELS.inProgress]);

      fake.author.closes = false;
      fake.existing.branch = true;
      expect((yield* runToEnd(starting, fake, work)).status).toBe("done");
    }),
  );

  effect("leaves an issue another run holds to it, whoever started it", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve", POOL);
      heldBy(fake, ISSUE_REF, { ...OTHER, flow: "human-initiated", withPerson: true });
      const skipped = yield* runToEnd(starting, fake, work);
      expect(skipped.status).toBe("skipped");
      expect(summaryOf(skipped)).toContain("`chernabog cancel another-run` to start it here");
      expect(fake.requests).toEqual([]);
    }),
  );
});

// Each item key names how its run owns the pull request.
const owningFlow = defineFlow({
  trigger: Effect.succeed([]),
  workflow: (owned) =>
    Effect.gen(function* () {
      if (owned.key === "owning-waits") {
        return yield* PullRequest.owning(PULL)(
          awaitSignal(["pushed"], { id: "wait", timeout: "1 hour" }),
        );
      }

      return yield* PullRequest.owning(PULL)(Review.round(PULL, 1)).pipe(
        Effect.map((review) => review.verdict),
      );
    }).pipe(
      Effect.catchTags({
        NotFound: (gone) => Effect.fail(new StepFailed({ step: owned.key, message: gone.message })),
        PullRequestClosed: (closed) =>
          Effect.fail(new StepFailed({ step: owned.key, message: closed.message })),
      }),
    ),
});

const owning = flowHandle(repo, "demo", owningFlow);

const requested = (fake: Fake) => {
  fake.people.requested = [fake.people.me];

  return fake;
};

describe("owning a pull request", () => {
  effect("holds the pull request's claim ref while the run waits, and lets it go at the end", () =>
    Effect.gen(function* () {
      const waiting = makeFake("approve");

      const parked = yield* runUntil(owning, waiting, item("owning-waits"), (run) =>
        listRunWaitsHandler({ runId: run.id, signal: "pushed" }).pipe(
          Effect.map(({ waits }) => waits.length > 0),
        ),
      );

      expect(Option.map(holderOf(waiting, PULL_REF), (holder) => holder.runId)).toEqual(
        Option.some(parked.id),
      );

      const done = makeFake("approve");
      expect((yield* runToEnd(owning, done, item("owning"))).status).toBe("done");
      expect(done.refs.has(PULL_REF)).toBe(false);
    }),
  );

  effect("skips a pull request another run owns", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      heldBy(fake, PULL_REF);
      const skipped = yield* runToEnd(owning, fake, item("owning"));
      expect(skipped.status).toBe("skipped");
      expect(summaryOf(skipped)).toContain(`#${PULL} is owned by another run`);
      expect(fake.reviews).toEqual([]);
      expect(holderOf(fake, PULL_REF)).toEqual(Option.some(OTHER));
    }),
  );

  effect(
    "the review trigger decides from the claim ref, and takes the pull request once this machine knows its holder ended",
    () =>
      Effect.gen(function* () {
        const fake = requested(makeFake("approve"));
        heldBy(fake, PULL_REF);
        expect(yield* flowTriggered(fake, reviewFlow)).toEqual([]);

        fake.knowRun(false);
        expect((yield* flowTriggered(fake, reviewFlow)).map((found) => found.key)).toEqual([
          `pr-${PULL}`,
        ]);
      }),
  );
});
