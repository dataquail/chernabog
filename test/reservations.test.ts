// A CI plan job's reservation of an item (#519), against an in-memory GitHub:
// whoever reserves an item first holds it, so of two plans for one step only
// one starts a run job; the run that job starts replaces the reservation as no
// takeover, and no other run may while its lease lasts.

import { Claims, DEFAULT_LABELS, GitHub, Run } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import implement from "../packages/recipes/flows/implement.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { effect } from "./effect-test.ts";
import { type Fake, ISSUE, item, makeFake, onFake, repo, runToEnd } from "./sdk-fakes.ts";

const work = item(`issue-${ISSUE}`, { issue: ISSUE });
const POOL = { reviewers: ["zach", "data-quail"] };
const CLAIM = Claims.issue(ISSUE);
const ISSUE_REF = Claims.refFor(CLAIM);
const TTL = Duration.minutes(15);

const PLAN = { runId: "ci-plan-41", flow: "implement" };
const OTHER_PLAN = { runId: "ci-plan-42", flow: "implement" };

const claimOf = (fake: Fake, sha: string) => Claims.holderOf(fake.commits.get(sha) ?? "");

const holderOf = (fake: Fake) =>
  Option.flatMap(Option.fromUndefinedOr(fake.refs.get(ISSUE_REF)), (sha) => claimOf(fake, sha));

// Runs `body` as the run `runId`, which the reservation `takesOver` was made for, if any.
const asRun = <A, E, R>(
  fake: Fake,
  runId: string,
  body: Effect.Effect<A, E, R>,
  takesOver: Option.Option<string> = Option.none(),
) =>
  onFake(
    fake,
    Effect.provideService(body, Run, {
      flow: "implement",
      runId,
      executionId: `execution-${runId}`,
      item: work,
      ...Option.match(takesOver, {
        onNone: () => ({}),
        onSome: (reserved) => ({ takesOver: reserved }),
      }),
    }),
  );

describe("reserving an item", () => {
  effect("claims it for the reservation's run id, on a lease of its own", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");

      expect(yield* onFake(fake, Claims.reserve(CLAIM, PLAN, TTL))).toEqual({ reserved: true });

      const held = Option.getOrThrow(holderOf(fake));
      expect(held.runId).toBe("ci-plan-41");
      expect(held.flow).toBe("implement");
      // A reservation is no person's work.
      expect(held.withPerson).toBe(false);
      expect(Claims.expired(held, yield* DateTime.now)).toBe(false);
      expect(
        Claims.expired(held, DateTime.addDuration(yield* DateTime.now, Duration.minutes(16))),
      ).toBe(true);
    }),
  );

  effect("a second plan finds it reserved, and is told by whom", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      yield* onFake(fake, Claims.reserve(CLAIM, PLAN, TTL));

      const second = yield* onFake(fake, Claims.reserve(CLAIM, OTHER_PLAN, TTL));

      // Told by whom: the first plan, whose reservation stands.
      expect(second).toEqual({ reserved: false, holder: holderOf(fake) });
      expect(Option.getOrThrow(holderOf(fake)).runId).toBe("ci-plan-41");
    }),
  );

  effect("the same plan reserving it again keeps it", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      yield* onFake(fake, Claims.reserve(CLAIM, PLAN, TTL));

      expect(yield* onFake(fake, Claims.reserve(CLAIM, PLAN, TTL))).toEqual({ reserved: true });
    }),
  );

  effect("a run's live claim keeps the item from a plan", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      yield* asRun(fake, "a-run", Claims.acquire(CLAIM));

      const plan = yield* onFake(fake, Claims.reserve(CLAIM, PLAN, TTL));

      expect(plan.reserved).toBe(false);
      expect(Option.getOrThrow(holderOf(fake)).runId).toBe("a-run");
    }),
  );

  effect("one whose lease ran out goes to the next plan", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      yield* onFake(fake, Claims.reserve(CLAIM, PLAN, Duration.zero));

      expect(yield* onFake(fake, Claims.reserve(CLAIM, OTHER_PLAN, TTL))).toEqual({
        reserved: true,
      });
      expect(Option.getOrThrow(holderOf(fake)).runId).toBe("ci-plan-42");
    }),
  );
});

describe("a run taking its reservation over", () => {
  effect("replaces the live reservation with its own claim, as no takeover", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      yield* onFake(fake, Claims.reserve(CLAIM, PLAN, TTL));
      const reservation = Option.getOrThrow(Option.fromUndefinedOr(fake.refs.get(ISSUE_REF)));

      const taken = yield* asRun(fake, "the-run", Claims.acquire(CLAIM), Option.some("ci-plan-41"));

      expect(taken).toEqual({ acquired: true, takenOver: Option.none() });
      const held = Option.getOrThrow(holderOf(fake));
      expect(held.runId).toBe("the-run");
      expect(held.takenOverFrom).toBeUndefined();
      // A commit on top of the reservation, as a renewal or a takeover is.
      expect(fake.refs.get(ISSUE_REF)).not.toBe(reservation);
    }),
  );

  effect(
    "a run that loses the reservation to a writer that replaced it first is told by whom",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve");
        yield* onFake(fake, Claims.reserve(CLAIM, PLAN, TTL));

        const github = yield* onFake(fake, GitHub);

        const winner: Claims.Holder = {
          runId: "another-run",
          persona: "data-quail",
          flow: "implement",
          claimedAt: "2026-10-26T14:00:00.000Z",
          withPerson: false,
        };

        // Another writer makes the lease ref on the reservation just before this run does.
        const beaten = {
          ...github,
          createRef: (ref: string, sha: string) =>
            Effect.sync(() => {
              if (ref.startsWith("refs/chernabog/leases/")) {
                fake.commits.set("taken000", Claims.messageOf(winner));
                fake.refs.set(ref, "taken000");
              }
            }).pipe(Effect.andThen(github.createRef(ref, sha))),
        };

        const taken = yield* asRun(
          fake,
          "the-run",
          Effect.provideService(Claims.acquire(CLAIM), GitHub, beaten),
          Option.some("ci-plan-41"),
        );

        expect(taken).toEqual({ acquired: false, holder: Option.some(winner) });
        expect(fake.refs.get(ISSUE_REF)).toBe("taken000");
      }),
  );

  effect("a run another plan's reservation was made for can't take this one", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      yield* onFake(fake, Claims.reserve(CLAIM, PLAN, TTL));

      const taken = yield* asRun(
        fake,
        "another-run",
        Claims.acquire(CLAIM),
        Option.some("ci-plan-42"),
      );

      expect(taken.acquired).toBe(false);
      expect(Option.getOrThrow(holderOf(fake)).runId).toBe("ci-plan-41");
    }),
  );

  effect("a run nothing was reserved for can't take a live reservation", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      yield* onFake(fake, Claims.reserve(CLAIM, PLAN, TTL));

      const taken = yield* asRun(fake, "a-daemon-run", Claims.acquire(CLAIM));

      expect(taken.acquired).toBe(false);
    }),
  );

  effect("an implement run takes the issue from its reservation, and says no takeover", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve", POOL);
      fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
      yield* onFake(fake, Claims.reserve(CLAIM, PLAN, TTL));

      const handle = flowHandle(
        { ...repo, leases: { ...repo.leases, takesOver: "ci-plan-41" } },
        "implement",
        implement,
      );

      const finished = yield* runToEnd(handle, fake, work);

      expect(finished.status).toBe("done");
      expect(fake.comments.some((comment) => comment.body.startsWith("Taken over"))).toBe(false);
      // The run's claim was the one on top of the reservation.
      expect(
        [...fake.commits.values()]
          .flatMap((message) => Option.toArray(Claims.holderOf(message)))
          .some((found) => found.runId === finished.id),
      ).toBe(true);
    }),
  );
});
