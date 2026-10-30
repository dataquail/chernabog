// Claims as leases (#134), against an in-memory GitHub: a claim records when
// it expires; renewing and taking over each replace the claim commit through
// a lease ref only one writer can create, so exactly one of a holder and a
// would-be taker wins; a run takes over an issue whose lease expired, adopting
// its branch and saying from whom; and a run that lost its claim ends as lost
// before it pushes.

import {
  activity,
  Claims,
  DEFAULT_LABELS,
  defineFlow,
  Git,
  GitHub,
  Run,
  StepFailed,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import implement from "../packages/recipes/flows/implement.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { effect } from "./effect-test.ts";
import {
  type Fake,
  ISSUE,
  item,
  makeFake,
  onFake,
  repo,
  runToEnd,
  summaryOf,
} from "./sdk-fakes.ts";

const implementing = flowHandle(repo, "implement", implement);
const work = item(`issue-${ISSUE}`, { issue: ISSUE });
const POOL = { reviewers: ["zach", "data-quail"] };
const CLAIM = Claims.issue(ISSUE);
const ISSUE_REF = Claims.refFor(CLAIM);

const PAST = "2026-10-26T14:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

const OTHER: Claims.Holder = {
  runId: "another-run",
  persona: "data-quail",
  flow: "implement",
  claimedAt: "2026-10-26T02:00:00.000Z",
  withPerson: false,
  expiresAt: PAST,
};

// The claim ref names a run of another machine's, whose lease runs to `expiresAt`.
const heldBy = (fake: Fake, expiresAt: string) => {
  fake.commits.set("held0000", Claims.messageOf({ ...OTHER, expiresAt }));
  fake.refs.set(ISSUE_REF, "held0000");
};

const holderOf = (fake: Fake) =>
  Option.flatMap(Option.fromUndefinedOr(fake.refs.get(ISSUE_REF)), (sha) =>
    Claims.holderOf(fake.commits.get(sha) ?? ""),
  );

// Runs `effect` against the fake as the run `runId`, outside the engine.
const asRun = <A, E, R>(fake: Fake, runId: string, body: Effect.Effect<A, E, R>) =>
  onFake(
    fake,
    Effect.provideService(body, Run, {
      flow: "implement",
      runId,
      executionId: `execution-${runId}`,
      item: work,
    }),
  );

const leaseRefs = (fake: Fake) =>
  [...fake.refs.keys()].filter((ref) => ref.startsWith("refs/chernabog/leases/"));

describe("a claim commit", () => {
  effect("records when its lease runs out, its renewal and whom it took over from", () =>
    Effect.sync(() => {
      const leased: Claims.Holder = {
        ...OTHER,
        expiresAt: FUTURE,
        renewedAt: PAST,
        takenOverFrom: "a-lost-run",
      };

      const message = Claims.messageOf(leased);

      expect(message.split("\n").slice(6)).toEqual([
        `Expires-At: ${FUTURE}`,
        `Renewed-At: ${PAST}`,
        "Taken-Over-From: a-lost-run",
      ]);
      expect(Claims.holderOf(message)).toEqual(Option.some(leased));
    }),
  );

  effect("expires only once its time has passed, and never without one", () =>
    Effect.sync(() => {
      const now = DateTime.makeUnsafe("2026-10-27T00:00:00.000Z");
      const { expiresAt: _, ...unleased } = OTHER;

      expect(Claims.expired(OTHER, now)).toBe(true);
      expect(Claims.expired({ ...OTHER, expiresAt: FUTURE }, now)).toBe(false);
      expect(Claims.expired(unleased, now)).toBe(false);
    }),
  );
});

describe("taking over an expired claim", () => {
  effect("an implement run takes the issue over, adopts its branch, and says from whom", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve", POOL);
      fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
      fake.existing.branch = true;
      heldBy(fake, PAST);

      const finished = yield* runToEnd(implementing, fake, work);
      expect(finished.status).toBe("done");

      // The takeover is a commit on top of the expired claim.
      const takeovers = [...fake.commits.values()]
        .flatMap((message) => Option.toArray(Claims.holderOf(message)))
        .filter((found) => found.runId === finished.id && found.takenOverFrom === "another-run");

      expect(takeovers).toHaveLength(1);

      expect(
        fake.comments.some((comment) =>
          comment.body.startsWith(
            `Taken over from data-quail's run another-run after its lease expired at ${PAST}.`,
          ),
        ),
      ).toBe(true);
      expect(fake.git.opened).toBe(true);
      // Released at the end, as any claim, with no lease ref left behind.
      expect(fake.refs.has(ISSUE_REF)).toBe(false);
      expect(leaseRefs(fake)).toEqual([]);
    }),
  );

  effect("leaves an issue whose lease hasn't run out to its holder", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve", POOL);
      heldBy(fake, FUTURE);

      const skipped = yield* runToEnd(implementing, fake, work);
      expect(skipped.status).toBe("skipped");
      expect(summaryOf(skipped)).toBe(
        `#${ISSUE} is already claimed (run another-run of implement holds ${ISSUE_REF}, its lease runs to ${FUTURE})`,
      );
      expect(holderOf(fake)).toEqual(Option.some({ ...OTHER, expiresAt: FUTURE }));
    }),
  );
});

describe("renewing a lease", () => {
  effect("moves the claim on to a commit on top of it, with a later expiry", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      heldBy(fake, PAST);

      const renewal = yield* asRun(
        fake,
        "another-run",
        Claims.renew(CLAIM, "another-run", Duration.hours(2)),
      );

      expect(renewal.status).toBe("renewed");

      const renewed = Option.getOrThrow(holderOf(fake));
      expect(renewed.runId).toBe("another-run");
      expect(renewed.claimedAt).toBe(OTHER.claimedAt);
      expect(Option.isSome(Option.fromUndefinedOr(renewed.renewedAt))).toBe(true);
      expect(Claims.expired(renewed, yield* DateTime.now)).toBe(false);
      expect(leaseRefs(fake)).toEqual([]);
    }),
  );

  effect("a holder that renews first keeps the item from a would-be taker", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      heldBy(fake, PAST);

      yield* asRun(fake, "another-run", Claims.renew(CLAIM, "another-run", Duration.hours(2)));
      const taken = yield* asRun(fake, "taker", Claims.acquire(CLAIM));

      expect(taken.acquired).toBe(false);
      expect(Option.getOrThrow(holderOf(fake)).runId).toBe("another-run");
    }),
  );

  effect("a holder whose expired claim was taken over first has lost it", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      heldBy(fake, PAST);

      const taken = yield* asRun(fake, "taker", Claims.acquire(CLAIM));
      expect(taken).toEqual({ acquired: true, takenOver: Option.some(OTHER) });

      const renewal = yield* asRun(
        fake,
        "another-run",
        Claims.renew(CLAIM, "another-run", Duration.hours(2)),
      );

      expect(renewal.status).toBe("lost");
      expect(Option.getOrThrow(holderOf(fake)).runId).toBe("taker");
    }),
  );

  effect(
    "of two writers replacing one claim commit, only the one that makes its lease ref wins",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve");
        heldBy(fake, PAST);
        // A taker made the lease ref and stopped before it moved the claim ref.
        fake.commits.set(
          "taken000",
          Claims.messageOf({ ...OTHER, runId: "taker", expiresAt: FUTURE }),
        );
        fake.refs.set(Claims.leaseRefFor(CLAIM, "held0000"), "taken000");

        const renewal = yield* asRun(
          fake,
          "another-run",
          Claims.renew(CLAIM, "another-run", Duration.hours(2)),
        );

        expect(renewal.status).toBe("lost");
        // A reader finished the taker's move for it.
        expect(fake.refs.get(ISSUE_REF)).toBe("taken000");
        expect(leaseRefs(fake)).toEqual([]);
      }),
  );

  effect(
    "a holder that read its claim before a taker replaced it, and asks after, leaves the taker's",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve");
        heldBy(fake, FUTURE);

        const github = yield* onFake(fake, GitHub);

        // Between the holder's read and its lease ref, a taker replaces the
        // claim commit and lets go of its own lease ref.
        const takenMeanwhile = {
          ...github,
          createCommit: (commit: Parameters<typeof github.createCommit>[0]) =>
            Effect.sync(() => {
              fake.commits.set(
                "taken000",
                Claims.messageOf({ ...OTHER, runId: "taker", expiresAt: FUTURE }),
              );
              fake.refs.set(ISSUE_REF, "taken000");
            }).pipe(Effect.andThen(github.createCommit(commit))),
        };

        const renewal = yield* asRun(
          fake,
          "another-run",
          Effect.provideService(
            Claims.renew(CLAIM, "another-run", Duration.hours(2)),
            GitHub,
            takenMeanwhile,
          ),
        );

        expect(renewal.status).toBe("lost");
        expect(fake.refs.get(ISSUE_REF)).toBe("taken000");
        expect(leaseRefs(fake)).toEqual([]);
      }),
  );
});

describe("a run that lost its claim", () => {
  effect("ends as lost before it pushes, saying who took over", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");

      const losing = defineFlow({
        trigger: Effect.succeed([]),
        workflow: () =>
          Effect.gen(function* () {
            yield* activity(
              "claim",
              Claims.acquire(CLAIM).pipe(Effect.map((claimed) => claimed.acquired)),
              Schema.Boolean,
            );
            // Its machine sleeps past its lease, and another run takes the issue over.
            yield* activity(
              "sleep",
              Effect.sync(() => {
                fake.commits.set(
                  "taken000",
                  Claims.messageOf({ ...OTHER, runId: "taker", expiresAt: FUTURE }),
                );
                fake.refs.set(ISSUE_REF, "taken000");
              }),
            );
            yield* activity(
              "push",
              Git.use((git) => git.push(".", "auto/issue-3")).pipe(
                Effect.mapError(
                  (rejected) => new StepFailed({ step: "push", message: rejected.message }),
                ),
              ),
            );

            return "pushed";
          }),
      });

      const ended = yield* runToEnd(flowHandle(repo, "losing", losing), fake, work);

      expect(ended.status).toBe("lost");
      expect(summaryOf(ended)).toBe(
        "data-quail's run taker of implement took issue-3 over; stopped before pushing auto/issue-3",
      );
      expect(fake.git.pushes).toBe(0);
      // What it held is the taker's now.
      expect(fake.refs.get(ISSUE_REF)).toBe("taken000");
    }),
  );
});
