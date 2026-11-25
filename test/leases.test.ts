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
  type RefCommit,
  Run,
  RunLog,
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

const TAKER: Claims.Holder = { ...OTHER, runId: "taker", expiresAt: FUTURE };

// The fake's GitHub, but for what `change` replaces in it, for one run.
const withGitHub = <A, E, R>(
  fake: Fake,
  change: (github: GitHub["Service"]) => Partial<GitHub["Service"]>,
  body: Effect.Effect<A, E, R>,
) =>
  onFake(fake, GitHub).pipe(
    Effect.flatMap((github) =>
      Effect.provideService(body, GitHub, { ...github, ...change(github) }),
    ),
  );

// Another writer makes each lease ref this one asks for just before it does,
// for its own commit `taken000` naming the taker, and stops there.
const leaseTakenFirst = (fake: Fake) => (github: GitHub["Service"]) => ({
  createRef: (ref: string, sha: string) =>
    Effect.sync(() => {
      if (ref.startsWith("refs/chernabog/leases/")) {
        fake.commits.set("taken000", Claims.messageOf(TAKER));
        fake.refs.set(ref, "taken000");
      }
    }).pipe(Effect.andThen(github.createRef(ref, sha))),
});

type NewCommit = Parameters<GitHub["Service"]["createCommit"]>[0];

// Keeps each commit asked for in `made`, as GitHub would make it.
const keepingCommits = (made: Array<NewCommit>) => (github: GitHub["Service"]) => ({
  createCommit: (commit: NewCommit) =>
    Effect.sync(() => made.push(commit)).pipe(Effect.andThen(github.createCommit(commit))),
});

// The claim ref's lease as the daemon renews it for `ttl`, or checks it with none.
const leaseOf = (
  args: { readonly item: string; readonly runId: string },
  ttl = Option.none<Duration.Duration>(),
) =>
  Effect.provideService(
    Option.getOrThrow(Option.fromUndefinedOr(Claims.refMarker.leaseJson))(args, ttl),
    RunLog,
    RunLog.of({
      log: () => Effect.void,
      step: () => Effect.void,
      stepDone: () => Effect.void,
      stepFinished: () => Effect.void,
    }),
  );

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

describe("the commits a claim is made of", () => {
  effect(
    "a claim is a commit with git's empty tree and no parent, and each one after it sits on the one it replaces",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve");
        const made: Array<NewCommit> = [];

        yield* asRun(
          fake,
          "first-run",
          withGitHub(fake, keepingCommits(made), Claims.acquire(CLAIM)),
        );
        const first = Option.getOrThrow(Option.fromUndefinedOr(fake.refs.get(ISSUE_REF)));

        yield* asRun(
          fake,
          "first-run",
          withGitHub(
            fake,
            keepingCommits(made),
            Claims.renew(CLAIM, "first-run", Duration.hours(2)),
          ),
        );

        expect(made.map((commit) => ({ tree: commit.tree, parents: commit.parents }))).toEqual([
          { tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", parents: [] },
          { tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", parents: [first] },
        ]);
      }),
  );
});

describe("reading a claim a writer left half moved", () => {
  // Ten writers each won the lease ref on the claim commit before theirs and stopped before moving the claim ref.
  const chain = (fake: Fake) => {
    heldBy(fake, FUTURE);
    const shas = ["held0000", ...Array.from({ length: 10 }, (_, at) => `moved${at + 1}`)];

    shas.slice(1).forEach((sha, at) => {
      fake.commits.set(
        sha,
        Claims.messageOf({ ...OTHER, runId: `writer-${at + 1}`, expiresAt: FUTURE }),
      );
      fake.refs.set(`refs/chernabog/leases/issue-3/${shas[at] ?? ""}`, sha);
    });
  };

  effect("finishes at most eight of their moves at a time, and the rest on the next read", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      chain(fake);

      const first = yield* onFake(fake, Claims.holder(CLAIM));
      expect(Option.map(first, (found) => found.runId)).toEqual(Option.some("writer-8"));
      expect(fake.refs.get(ISSUE_REF)).toBe("moved8");
      expect(leaseRefs(fake)).toHaveLength(2);

      const next = yield* onFake(fake, Claims.holder(CLAIM));
      expect(Option.map(next, (found) => found.runId)).toEqual(Option.some("writer-10"));
      expect(leaseRefs(fake)).toEqual([]);
    }),
  );
});

describe("taking over an expired claim", () => {
  effect("a run that loses the takeover to another taker is told who won", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      heldBy(fake, PAST);

      const taken = yield* asRun(
        fake,
        "late-taker",
        withGitHub(fake, leaseTakenFirst(fake), Claims.acquire(CLAIM)),
      );

      expect(taken).toEqual({ acquired: false, holder: Option.some(TAKER) });
      expect(fake.refs.get(ISSUE_REF)).toBe("taken000");
      expect(leaseRefs(fake)).toEqual([]);
    }),
  );

  effect(
    "a run that creates the claim ref holds it, even when GitHub's read of the ref lags behind",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve");

        const lagging = (github: GitHub["Service"]) => ({
          ref: (ref: string) =>
            Effect.suspend(() => {
              if (ref === ISSUE_REF) {
                return Effect.succeed(Option.none<RefCommit>());
              }

              return github.ref(ref);
            }),
        });

        const taken = yield* asRun(
          fake,
          "first-run",
          withGitHub(fake, lagging, Claims.acquire(CLAIM)),
        );

        expect(taken).toEqual({ acquired: true, takenOver: Option.none() });
        expect(Option.map(holderOf(fake), (found) => found.runId)).toEqual(
          Option.some("first-run"),
        );
      }),
  );

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
  effect("finds nothing to renew when nobody holds the claim any more", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");

      expect(
        yield* asRun(fake, "another-run", Claims.renew(CLAIM, "another-run", Duration.hours(2))),
      ).toEqual({ status: "released" });
      expect(fake.refs.has(ISSUE_REF)).toBe(false);
    }),
  );

  effect("a holder that loses the race for the lease ref to a taker has lost the item to it", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      heldBy(fake, PAST);

      const renewal = yield* asRun(
        fake,
        "another-run",
        withGitHub(
          fake,
          leaseTakenFirst(fake),
          Claims.renew(CLAIM, "another-run", Duration.hours(2)),
        ),
      );

      expect(renewal).toEqual({ status: "lost", holder: Option.some(TAKER) });
      expect(fake.refs.get(ISSUE_REF)).toBe("taken000");
      expect(leaseRefs(fake)).toEqual([]);
    }),
  );

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
        fake.refs.set("refs/chernabog/leases/issue-3/held0000", "taken000");

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

describe("the claim ref's lease, as the daemon renews and checks it", () => {
  const args = { item: CLAIM, runId: "another-run" };
  const renewing = Option.some(Duration.hours(2));

  effect("renewing it reports the claim held, until when, and when it was renewed", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      heldBy(fake, PAST);

      const lease = yield* asRun(fake, "another-run", leaseOf(args, renewing));
      const renewed = Option.getOrThrow(holderOf(fake));

      expect(lease).toMatchObject({
        on: "issue-3",
        report: { status: "held", expiresAt: renewed.expiresAt },
      });
      expect(Claims.expired(renewed, yield* DateTime.now)).toBe(false);
    }),
  );

  effect("checking it reports the claim's lease as its commit has it, without renewing it", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.commits.set(
        "held0000",
        Claims.messageOf({ ...OTHER, expiresAt: FUTURE, renewedAt: PAST }),
      );
      fake.refs.set(ISSUE_REF, "held0000");

      expect(yield* asRun(fake, "another-run", leaseOf(args))).toEqual({
        on: "issue-3",
        report: { status: "held", expiresAt: FUTURE, renewedAt: PAST },
      });
      expect(fake.refs.get(ISSUE_REF)).toBe("held0000");
    }),
  );

  effect(
    "renewing or checking it once another run took the item over reports it lost, to whom",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve");
        fake.commits.set("taken000", Claims.messageOf(TAKER));
        fake.refs.set(ISSUE_REF, "taken000");

        const lost = {
          on: "issue-3",
          report: {
            status: "lost",
            reason: "data-quail's run taker of implement took issue-3 over",
          },
        } as const;

        expect(yield* asRun(fake, "another-run", leaseOf(args, renewing))).toEqual(lost);
        expect(yield* asRun(fake, "another-run", leaseOf(args))).toEqual(lost);
        expect(fake.refs.get(ISSUE_REF)).toBe("taken000");
      }),
  );

  effect("renewing or checking it once nobody holds the claim reports it let go", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      const released = { on: "issue-3", report: { status: "released" } } as const;

      expect(yield* asRun(fake, "another-run", leaseOf(args, renewing))).toEqual(released);
      expect(yield* asRun(fake, "another-run", leaseOf(args))).toEqual(released);
      expect(fake.refs.has(ISSUE_REF)).toBe(false);
    }),
  );

  effect("a hold naming another run is not this run's to renew, and is reported let go", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      heldBy(fake, PAST);
      const released = { on: "issue-3", report: { status: "released" } } as const;

      expect(yield* asRun(fake, "this-run", leaseOf(args, renewing))).toEqual(released);
      expect(yield* asRun(fake, "this-run", leaseOf(args))).toEqual(released);
      expect(fake.refs.get(ISSUE_REF)).toBe("held0000");
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
