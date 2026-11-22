// Phases' own rules, against the in-memory Progress adapter, without the
// engine: a write that loses a race reads again (ADR 21, decision 5's
// compare-and-set), `again` and a park's record (decision 4), the CI waits'
// rounds, a work item's key, and the step a progress.advance records in. A
// park and a progress.advance run in Effect's in-memory workflow engine,
// which gives their activities a journal, so park's tests take milliseconds
// where the engine's runs wait in real time (#589).

import {
  CurrentNode,
  GitHub,
  type Json,
  type NodeAt,
  Phase,
  PHASE_DATA_MAX_BYTES,
  PhaseData,
  type PhaseRecord,
  Phases,
  PhaseWriter,
  Progress,
  Run,
  RunLog,
  Signals,
} from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";

import { effect } from "./effect-test.ts";
import { EARLIER_RUN, progressStore } from "./progress-fake.ts";

const asPhase = Schema.decodeSync(Phase);
const asWriter = Schema.decodeSync(PhaseWriter);
const asData = Schema.decodeUnknownSync(PhaseData);

const ITEM = Phases.issueItem(3);
const PR_ITEM = Phases.pullRequestItem(7);
const P = Phases.PHASES;

// This run, and the other writer a race is lost to.
const THIS_RUN = "00000000-0000-4000-8000-00000000000a";
const THIS_WRITER = asWriter(THIS_RUN);
const OTHER = asWriter(EARLIER_RUN);

const RUN = Run.of({
  flow: "phases",
  runId: THIS_RUN,
  executionId: "phases-execution",
  item: { key: ITEM, data: {} },
});

type Store = ReturnType<typeof progressStore>;

// The adapter over `store`, with another writer moving `item` to `phase`
// just before each of the next `losses` advances: each loses the race.
const losing = (store: Store, losses: number, phase: string = P.issue.askedQuestions) => {
  let left = losses;
  let advances = 0;

  const service: Progress["Service"] = {
    ...store.service,
    advance: (item, transition) =>
      Effect.suspend(() => {
        advances += 1;

        if (left > 0) {
          left -= 1;
          store.seed(item, asPhase(phase), OTHER);
        }

        return store.service.advance(item, transition);
      }),
  };

  return { service, advances: () => advances };
};

// `body` as this run, over `progress`.
const asRun = <A, E, R>(body: Effect.Effect<A, E, R>, progress: Progress["Service"]) =>
  body.pipe(Effect.provideService(Progress, progress), Effect.provideService(Run, RUN));

const recordOf = (store: Store, item: string = ITEM) =>
  Option.fromUndefinedOr(store.records().get(item));

const REVIEW: Phases.Reviewed = {
  sha: "abc123",
  reviewer: "chernabog-reviewer",
  round: 1,
  verdict: "request-changes",
};

const dataOf = (
  store: Store,
  item: string = ITEM,
): Option.Option<{ readonly [key: string]: Json }> =>
  Option.flatMap(recordOf(store, item), (found) => found.data);

describe("Phases.record", () => {
  effect("reads again after a lost race, and moves on from the record it finds", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });
      const racing = losing(store, 1);

      const written = yield* asRun(Phases.recording(ITEM, P.issue.proposed), racing.service);

      expect(racing.advances()).toBe(2);
      expect(written.phase).toBe(asPhase(P.issue.proposed));
      expect(written.by).toBe(THIS_WRITER);
      expect(written.from).toEqual(Option.some(asPhase(P.issue.askedQuestions)));
      expect(written.blobs).toEqual([]);
      expect(recordOf(store)).toEqual(Option.some(written));
    }),
  );

  effect("moves on after two lost races", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });
      const racing = losing(store, 2);

      yield* asRun(Phases.record(ITEM, P.issue.proposed), racing.service);

      expect(racing.advances()).toBe(3);
      expect(store.phases()[ITEM]).toBe(P.issue.proposed);
    }),
  );

  effect("fails after losing three races, with the item where the other writer left it", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });
      const racing = losing(store, 3);

      const failed = yield* Effect.flip(
        asRun(Phases.record(ITEM, P.issue.proposed), racing.service),
      );

      expect(failed._tag).toBe("ProgressError");
      expect(racing.advances()).toBe(3);
      expect(store.phases()[ITEM]).toBe(P.issue.askedQuestions);
    }),
  );

  effect("writes nothing for an item at the phase already, whoever wrote it", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });
      store.seed(ITEM, asPhase(P.issue.proposed), OTHER, { data: asData({ round: 1 }) });
      const before = recordOf(store);

      yield* asRun(Phases.record(ITEM, P.issue.proposed, { round: 2 }), store.service);

      expect(recordOf(store)).toEqual(before);
    }),
  );

  effect("again: writes a fresh record over one another writer wrote at the phase", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });
      store.seed(ITEM, asPhase(P.issue.proposed), OTHER, { data: asData({ round: 1 }) });

      const written = yield* asRun(
        Phases.recording(ITEM, P.issue.proposed, { round: 2 }, { again: true }),
        store.service,
      );

      expect(written.by).toBe(THIS_WRITER);
      expect(written.version).toBe("v2");
      expect(dataOf(store)).toEqual(Option.some({ round: 2 }));
    }),
  );

  effect("again: keeps the record there when this run wrote it", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });
      store.seed(ITEM, asPhase(P.issue.proposed), THIS_WRITER, { data: asData({ round: 1 }) });

      const kept = yield* asRun(
        Phases.recording(ITEM, P.issue.proposed, { round: 2 }, { again: true }),
        store.service,
      );

      expect(kept.version).toBe("v1");
      expect(dataOf(store)).toEqual(Option.some({ round: 1 }));
    }),
  );

  effect("always: writes a fresh record even over one this run wrote", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });
      store.seed(ITEM, asPhase(P.issue.proposed), THIS_WRITER, { data: asData({ round: 1 }) });

      yield* asRun(
        Phases.record(ITEM, P.issue.proposed, { round: 2 }, { always: true }),
        store.service,
      );

      expect(Option.map(recordOf(store), (found) => found.version)).toEqual(Option.some("v2"));
      expect(dataOf(store)).toEqual(Option.some({ round: 2 }));
    }),
  );

  effect("carries a pull request's review into the record after it, beside the data given", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });
      store.seed(PR_ITEM, asPhase(P.pullRequest.changesAsked), OTHER, {
        data: asData(Phases.reviewData(REVIEW)),
      });

      yield* asRun(Phases.record(PR_ITEM, P.pullRequest.mergeHeld, { held: 1 }), store.service);
      expect(dataOf(store, PR_ITEM)).toEqual(
        Option.some({ held: 1, ...Phases.reviewData(REVIEW) }),
      );

      yield* asRun(Phases.record(PR_ITEM, P.pullRequest.watched), store.service);
      expect(dataOf(store, PR_ITEM)).toEqual(Option.some(Phases.reviewData(REVIEW)));
      expect(Option.flatMap(recordOf(store, PR_ITEM), Phases.reviewOf)).toEqual(
        Option.some(REVIEW),
      );
    }),
  );

  effect("keeps the review the data gives over the one the record had", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });
      store.seed(PR_ITEM, asPhase(P.pullRequest.changesAsked), OTHER, {
        data: asData(Phases.reviewData(REVIEW)),
      });
      const later = { ...REVIEW, sha: "def456", round: 2, verdict: "approve" as const };

      yield* asRun(
        Phases.record(PR_ITEM, P.pullRequest.approved, Phases.reviewData(later)),
        store.service,
      );

      expect(dataOf(store, PR_ITEM)).toEqual(Option.some(Phases.reviewData(later)));
    }),
  );
});

describe("Phases.reconcile", () => {
  effect("gives the record another writer moved the item to, having written nothing", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });
      store.seed(PR_ITEM, asPhase(P.pullRequest.reviewAsked), OTHER);
      const read = recordOf(store, PR_ITEM);
      store.seed(PR_ITEM, asPhase(P.pullRequest.approved), OTHER);
      const moved = recordOf(store, PR_ITEM);

      const after = yield* Phases.reconcile(
        PR_ITEM,
        read,
        P.pullRequest.changesAsked,
        "observer:reviewed",
      ).pipe(Effect.provideService(Progress, store.service));

      expect(after).toEqual(moved);
      expect(Option.map(after, (found) => found.phase)).toEqual(
        Option.some(asPhase(P.pullRequest.approved)),
      );
      expect(store.phases()[PR_ITEM]).toBe(P.pullRequest.approved);
    }),
  );

  effect("gives the record it wrote when the item is still the one it read", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });
      store.seed(PR_ITEM, asPhase(P.pullRequest.reviewAsked), OTHER);

      const after = yield* Phases.reconcile(
        PR_ITEM,
        recordOf(store, PR_ITEM),
        P.pullRequest.changesAsked,
        "observer:reviewed",
      ).pipe(Effect.provideService(Progress, store.service));

      expect(after).toEqual(recordOf(store, PR_ITEM));
      expect(store.phases()[PR_ITEM]).toBe(P.pullRequest.changesAsked);
    }),
  );

  effect("writes the data it is given, with the review the record it read keeps", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });
      store.seed(PR_ITEM, asPhase(P.pullRequest.changesAsked), OTHER, {
        data: asData(Phases.reviewData(REVIEW)),
      });

      yield* Phases.reconcile(
        PR_ITEM,
        recordOf(store, PR_ITEM),
        P.pullRequest.reviewAskedAgain,
        "observer:review-asked",
        { reviewed: ["chernabog-reviewer"] },
      ).pipe(Effect.provideService(Progress, store.service));

      expect(dataOf(store, PR_ITEM)).toEqual(
        Option.some({ reviewed: ["chernabog-reviewer"], ...Phases.reviewData(REVIEW) }),
      );
    }),
  );
});

describe("the waits for CI", () => {
  const CI = P.issue.awaitingCi;
  const CONFLICT_CI = P.pullRequest.awaitingConflictCi;

  test("a round's phase reads back as its round, however many digits it has", () => {
    expect(Phases.inRound(CI, 1)).toBe("awaiting-ci");
    expect(Phases.inRound(CI, 12)).toBe("awaiting-ci-12");
    expect(Phases.roundOf(CI, "awaiting-ci")).toEqual(Option.some(1));
    expect(Phases.roundOf(CI, "awaiting-ci-12")).toEqual(Option.some(12));
    expect(Phases.inRound(CONFLICT_CI, 1)).toBe("awaiting-conflict-ci");
    expect(Phases.inRound(CONFLICT_CI, 12)).toBe("awaiting-conflict-ci-12");
    expect(Phases.roundOf(CONFLICT_CI, "awaiting-conflict-ci")).toEqual(Option.some(1));
    expect(Phases.roundOf(CONFLICT_CI, "awaiting-conflict-ci-12")).toEqual(Option.some(12));
    expect(Phases.roundedOf("awaiting-conflict-ci-12")).toEqual(
      Option.some({ phase: CONFLICT_CI, round: 12 }),
    );
  });

  test("a round of one site's wait is no round of another's", () => {
    expect(Phases.roundOf(CI, "awaiting-conflict-ci-2")).toEqual(Option.none());
    expect(Phases.roundOf(CONFLICT_CI, "awaiting-ci-2")).toEqual(Option.none());
  });

  test("a team's own phase that only ends in one is no wait for CI", () => {
    expect(Phases.roundOf(CI, "not-awaiting-ci")).toEqual(Option.none());
    expect(Phases.roundOf(CI, "not-awaiting-ci-2")).toEqual(Option.none());
    expect(Phases.roundedOf("not-awaiting-ci-2")).toEqual(Option.none());
    expect(Phases.declaredAs("not-awaiting-ci")).toBe("not-awaiting-ci");
    expect(Phases.roundOf(CONFLICT_CI, "not-awaiting-conflict-ci")).toEqual(Option.none());
    expect(Phases.roundOf(CONFLICT_CI, "not-awaiting-conflict-ci-2")).toEqual(Option.none());
    expect(Phases.declaredAs("not-awaiting-conflict-ci")).toBe("not-awaiting-conflict-ci");
  });

  test("a phase that only starts as one is no wait for CI", () => {
    expect(Phases.roundOf(CI, "awaiting-ci-2x")).toEqual(Option.none());
    expect(Phases.roundOf(CI, "awaiting-ci-x")).toEqual(Option.none());
    expect(Phases.roundOf(CONFLICT_CI, "awaiting-conflict-ci-2x")).toEqual(Option.none());
    expect(Phases.roundOf(CONFLICT_CI, "awaiting-conflict-ci-x")).toEqual(Option.none());
    expect(Phases.roundedOf("awaiting-ci-2x")).toEqual(Option.none());
  });

  test("a later round of a wait for CI is declared as its first", () => {
    expect(Phases.declaredAs("awaiting-ci-12")).toBe("awaiting-ci");
    expect(Phases.declaredAs("awaiting-conflict-ci-3")).toBe("awaiting-conflict-ci");
    expect(Phases.declaredAs("awaiting-conflict-ci-12")).toBe("awaiting-conflict-ci");
  });

  test("a later round of a wait for a conflict's CI is a pull request's phase only", () => {
    expect(Phases.misplacedOn("pull-request", "awaiting-conflict-ci-2")).toEqual(Option.none());
    expect(Phases.misplacedOn("issue", "awaiting-conflict-ci-2")).toEqual(
      Option.some("awaiting-conflict-ci-2 isn't a phase of an issue"),
    );
    expect(Phases.misplacedOn("epic", "awaiting-conflict-ci-12")).toEqual(
      Option.some("awaiting-conflict-ci-12 isn't a phase of an epic"),
    );
  });
});

// A record as an adapter gives it, with `data` and `version`.
const aRecord = (
  phase: string,
  data: Option.Option<{ readonly [key: string]: Json }>,
  version = "v1",
): PhaseRecord => ({
  phase: asPhase(phase),
  from: Option.none(),
  by: OTHER,
  version,
  at: DateTime.makeUnsafe(0),
  data: Option.map(data, asData),
  blobs: [],
});

describe("Phases.reviewedBefore", () => {
  const found = aRecord(P.pullRequest.reviewAsked, Option.some({ reviewed: ["Alice", "bob"] }));

  test("is true for any of the reviewers the record lists, in any case", () => {
    expect(Phases.reviewedBefore(found, "alice")).toBe(true);
    expect(Phases.reviewedBefore(found, "BOB")).toBe(true);
  });

  test("is false for one it doesn't list, and for a record that lists none", () => {
    expect(Phases.reviewedBefore(found, "carol")).toBe(false);
    expect(
      Phases.reviewedBefore(aRecord(P.pullRequest.reviewAsked, Option.some({ adopted: 81 })), "a"),
    ).toBe(false);
  });
});

describe("Phases.keyFor", () => {
  test("is the item, its phase and the record's version shortened as a head SHA is", () => {
    const found = aRecord(P.pullRequest.changesAsked, Option.none(), "1a2b3c4d5e6f7081");

    expect(Phases.keyFor("pr-7", found)).toBe("pr-7-changes-asked-1a2b3c4");
  });
});

describe("Phases.reviewOf", () => {
  test("is the review a record keeps, and none for data that isn't one", () => {
    expect(
      Phases.reviewOf(aRecord(P.pullRequest.approved, Option.some(Phases.reviewData(REVIEW)))),
    ).toEqual(Option.some(REVIEW));
    expect(
      Phases.reviewOf(aRecord(P.pullRequest.approved, Option.some({ review: "approved" }))),
    ).toEqual(Option.none());
  });
});

describe("Phases.withPersonData", () => {
  // The data as a with-person record's reader decodes it.
  const read = Schema.decodeUnknownSync(Phases.WithPerson);

  test("keeps a why of up to a thousand characters whole, with the phase it left", () => {
    const why = "w".repeat(1000);

    expect(
      read(Phases.withPersonData(why, Option.some(aRecord(P.issue.proposed, Option.none())))),
    ).toEqual({ why, from: Option.some(P.issue.proposed) });
    expect(read(Phases.withPersonData("stuck", Option.none()))).toEqual({
      why: "stuck",
      from: Option.none(),
    });
  });

  test("cuts a longer why to a thousand characters, the last an ellipsis", () => {
    expect(read(Phases.withPersonData("w".repeat(1001), Option.none()))).toEqual({
      why: `${"w".repeat(999)}…`,
      from: Option.none(),
    });
  });
});

describe("Phases.numberOf", () => {
  test("is the number of an issue's, a pull request's or an epic's item", () => {
    expect(["issue-12", "pr-7", "epic-4"].map(Phases.numberOf)).toEqual([
      Option.some(12),
      Option.some(7),
      Option.some(4),
    ]);
  });

  test("is none for a team's own item", () => {
    expect(["my-issue-12", "pr-7a", "pr-", "team-7"].map(Phases.numberOf)).toEqual([
      Option.none(),
      Option.none(),
      Option.none(),
      Option.none(),
    ]);
  });
});

describe("Phases.PHASE_NAME", () => {
  test("is lower-case words joined by hyphens", () => {
    expect(
      ["triaged", "awaiting-ci-2", "a-b-c", "round2-x"].map((name) => Phases.PHASE_NAME.test(name)),
    ).toEqual([true, true, true, true]);
  });

  test("is nothing else", () => {
    expect(
      ["Triaged", "triaged-", "triaged!", "triaged-Two", "-triaged", "a--b", "a-!"].map((name) =>
        Phases.PHASE_NAME.test(name),
      ),
    ).toEqual([false, false, false, false, false, false, false]);
  });
});

describe("Phases.itemOfWork", () => {
  test("is the pull request a pull request's subject names", () => {
    expect(Phases.itemOfWork("changes-asked", { key: "k", data: { pullRequest: 7 } })).toEqual(
      Option.some("pr-7"),
    );
    expect(Phases.itemOfWork("conflict", { key: "k", data: { issue: 7 } })).toEqual(Option.none());
  });

  test("is the issue an issue's subject names, and the epic an epic's", () => {
    expect(Phases.itemOfWork("spec", { key: "k", data: { issue: 4 } })).toEqual(
      Option.some("issue-4"),
    );
    expect(Phases.itemOfWork("epic", { key: "k", data: { issue: 4 } })).toEqual(
      Option.some("epic-4"),
    );
    expect(Phases.itemOfWork("issue", { key: "k", data: { pullRequest: 4 } })).toEqual(
      Option.none(),
    );
  });

  test("is none for a subject the SDK doesn't know", () => {
    expect(Phases.itemOfWork("triage", { key: "k", data: { issue: 4 } })).toEqual(Option.none());
  });
});

describe("Phases.recordAwaitingReview", () => {
  // The data recordAwaitingReview records when `authors` have reviewed the
  // pull request.
  const recordingWith = (authors: ReadonlyArray<string>) => {
    const store = progressStore({ checked: false });

    const reviewed = Layer.mock(GitHub)({
      reviews: () =>
        Effect.succeed(authors.map((author) => ({ author, state: "APPROVED", commitSha: "s" }))),
    });

    return asRun(Phases.recordAwaitingReview(7, P.pullRequest.reviewAsked), store.service).pipe(
      Effect.provide(reviewed),
      Effect.map(() => dataOf(store, PR_ITEM)),
    );
  };

  effect("records who had reviewed the pull request, each once", () =>
    Effect.gen(function* () {
      expect(yield* recordingWith(["alice", "bob", "alice"])).toEqual(
        Option.some({ reviewed: ["alice", "bob"] }),
      );
    }),
  );

  effect("records no data when nobody had", () =>
    Effect.gen(function* () {
      expect(yield* recordingWith([])).toEqual(Option.none());
    }),
  );
});

// The workflow a test's effect runs in: each test builds its own engine, so
// the one execution id is new each time.
const Probe = Workflow.make("phases-probe", {
  payload: {},
  success: Schema.String,
  idempotencyKey: () => "probe",
});

type Ran = {
  // What the effect gave, or none while it is parked.
  readonly result: Option.Option<string>;
  // The steps its activities ran, in order.
  readonly steps: ReadonlyArray<string>;
  // Each signal it waits on, and the deferred a delivery completes.
  readonly waits: ReadonlyArray<string>;
};

// Runs `body` as a flow's workflow does, in the in-memory engine, until it
// ends or parks on its signals; `untilEnded` waits on past a park, for one
// a timeout ends.
const inWorkflow = (
  body: Effect.Effect<
    string,
    unknown,
    | Progress
    | Run
    | Signals
    | RunLog
    | WorkflowEngine.WorkflowEngine
    | WorkflowEngine.WorkflowInstance
  >,
  progress: Progress["Service"],
  untilEnded = false,
) =>
  Effect.gen(function* () {
    const steps: Array<string> = [];
    const waits: Array<string> = [];

    const services = Layer.mergeAll(
      Layer.succeed(Progress, progress),
      Layer.succeed(Run, RUN),
      Layer.succeed(
        Signals,
        Signals.of({
          register: (signal, deferred) =>
            Effect.sync(() => {
              waits.push(`${signal} ${deferred}`);
            }),
        }),
      ),
      Layer.succeed(
        RunLog,
        RunLog.of({
          log: () => Effect.void,
          step: (name) =>
            Effect.sync(() => {
              steps.push(name);
            }),
          stepDone: () => Effect.void,
          stepFinished: () => Effect.void,
        }),
      ),
    );

    const engine = yield* Layer.build(
      Probe.toLayer(() => Effect.orDie(body)).pipe(
        Layer.provideMerge(WorkflowEngine.layerMemory),
        Layer.provide(services),
      ),
    );

    const id = yield* Effect.provideContext(Probe.execute({}, { discard: true }), engine);

    // Polled until it has ended, or (unless untilEnded) has registered its
    // waits and stopped.
    const polled = yield* Effect.provideContext(Probe.poll(id), engine).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 millis"),
        until: (found) =>
          Option.exists(found, (now) => !untilEnded || !Predicate.isTagged(now, "Suspended")),
        times: 1000,
      }),
    );

    const result = Option.flatMap(polled, (ended) => {
      if (Predicate.isTagged(ended, "Suspended")) {
        return Option.none<string>();
      }

      return Option.some(
        Exit.match(ended.exit, { onSuccess: (gave) => gave, onFailure: () => "failed" }),
      );
    });

    const ran: Ran = { result, steps, waits };

    return ran;
  });

const WAIT: Phases.Parking = {
  step: "park-answer",
  item: ITEM,
  phase: P.issue.proposed,
  data: { round: 2 },
};

const SIGNALS = ["issue-commented", "issue-closed"];

const sinceIn = (store: Store) =>
  Phases.sinceOf(Option.flatMap(recordOf(store), (found) => found.data));

describe("Phases.park", () => {
  effect(
    "records the wait in its step, with its data and since now, and parks on the signals",
    () =>
      Effect.gen(function* () {
        const store = progressStore({ checked: false });
        const before = yield* DateTime.now;

        const ran = yield* inWorkflow(Phases.park(WAIT, SIGNALS, "answer"), store.service);
        const after = yield* DateTime.now;

        expect(ran.result).toEqual(Option.none());
        expect(ran.steps[0]).toBe("park-answer");
        expect(ran.waits).toEqual([
          "issue-commented issue-commented:answer",
          "issue-closed issue-closed:answer",
        ]);
        expect(store.phases()[ITEM]).toBe(P.issue.proposed);
        expect(Option.map(recordOf(store), (found) => found.by)).toEqual(Option.some(THIS_WRITER));
        expect(Option.map(recordOf(store), (found) => found.blobs)).toEqual(Option.some([]));
        expect(Option.getOrThrow(dataOf(store))).toMatchObject({ round: 2 });

        const since = Option.getOrThrow(sinceIn(store));
        expect(DateTime.isLessThanOrEqualTo(before, since)).toBe(true);
        expect(DateTime.isLessThanOrEqualTo(since, after)).toBe(true);
      }),
  );

  effect("keeps the since the data gives, for a wait that began before", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });

      yield* inWorkflow(
        Phases.park({ ...WAIT, data: { since: "2026-01-01T00:00:00.000Z" } }, SIGNALS, "answer"),
        store.service,
      );

      expect(dataOf(store)).toEqual(Option.some({ since: "2026-01-01T00:00:00.000Z" }));
    }),
  );

  effect("writes what the wait carries on: its data, and the blobs it names", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });

      yield* inWorkflow(
        Phases.park(
          { ...WAIT, carries: Effect.succeed({ data: { plan: "blob" }, blobs: ["the plan"] }) },
          SIGNALS,
          "answer",
        ),
        store.service,
      );

      expect(Option.getOrThrow(dataOf(store))).toMatchObject({ round: 2, plan: "blob" });
      expect(Option.map(recordOf(store), (found) => found.blobs.length)).toEqual(Option.some(1));
    }),
  );

  effect("leaves a record that is this wait as it is, and parks on the signals", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });
      store.seed(ITEM, asPhase(P.issue.proposed), OTHER, {
        data: asData({ since: DateTime.formatIso(yield* DateTime.now) }),
      });
      const kept = recordOf(store);

      const ran = yield* inWorkflow(
        Phases.park({ ...WAIT, timeout: Duration.hours(1) }, SIGNALS, "answer"),
        store.service,
      );

      expect(ran.result).toEqual(Option.none());
      expect(ran.waits.length).toBe(2);
      expect(recordOf(store)).toEqual(kept);
    }),
  );

  effect("writes the wait over a record at another phase", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });
      store.seed(ITEM, asPhase(P.issue.askedQuestions), OTHER);

      const ran = yield* inWorkflow(Phases.park(WAIT, SIGNALS, "answer"), store.service);

      expect(ran.waits.length).toBe(2);
      expect(store.phases()[ITEM]).toBe(P.issue.proposed);
    }),
  );

  effect("writes over a record at the phase that isn't this wait, even one this run wrote", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });
      store.seed(ITEM, asPhase(P.issue.proposed), THIS_WRITER, { data: asData({ round: 1 }) });

      yield* inWorkflow(
        Phases.park({ ...WAIT, keeps: (found) => found.by !== THIS_WRITER }, SIGNALS, "answer"),
        store.service,
      );

      expect(Option.map(recordOf(store), (found) => found.version)).toEqual(Option.some("v2"));
      expect(Option.getOrThrow(dataOf(store))).toMatchObject({ round: 2 });
    }),
  );

  effect("gives timed-out for a kept wait past its timeout, and waits on nothing", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });
      store.seed(ITEM, asPhase(P.issue.proposed), OTHER, {
        data: asData({ since: "2026-01-01T00:00:00.000Z" }),
      });
      const kept = recordOf(store);

      const ran = yield* inWorkflow(
        Phases.park({ ...WAIT, timeout: Duration.hours(1) }, SIGNALS, "answer"),
        store.service,
      );

      expect(ran.result).toEqual(Option.some("timed-out"));
      expect(ran.waits).toEqual([]);
      expect(recordOf(store)).toEqual(kept);
    }),
  );

  effect("gives timeout once a fresh wait's timeout runs out", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });

      const ran = yield* inWorkflow(
        Phases.park({ ...WAIT, timeout: Duration.millis(1) }, SIGNALS, "answer"),
        store.service,
        true,
      );

      expect(ran.result).toEqual(Option.some("timeout"));
      expect(store.phases()[ITEM]).toBe(P.issue.proposed);
    }),
  );
});

describe("Phases.recordParking", () => {
  effect("gives parked, having recorded the wait, for a wait that polls", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });

      const ran = yield* inWorkflow(Phases.recordParking(WAIT), store.service);

      expect(ran.result).toEqual(Option.some("parked"));
      expect(ran.waits).toEqual([]);
      expect(store.phases()[ITEM]).toBe(P.issue.proposed);
    }),
  );

  effect("gives parked for a kept wait without a timeout, however long ago it began", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });
      store.seed(ITEM, asPhase(P.issue.proposed), OTHER, {
        data: asData({ since: "2020-01-01T00:00:00.000Z" }),
      });

      const ran = yield* inWorkflow(Phases.recordParking(WAIT), store.service);

      expect(ran.result).toEqual(Option.some("parked"));
      expect(Option.map(recordOf(store), (found) => found.version)).toEqual(Option.some("v1"));
    }),
  );

  effect("gives parked for a kept wait whose since isn't a time", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });
      store.seed(ITEM, asPhase(P.issue.proposed), OTHER, { data: asData({ since: 5 }) });

      const ran = yield* inWorkflow(
        Phases.recordParking({ ...WAIT, timeout: Duration.hours(1) }),
        store.service,
      );

      expect(ran.result).toEqual(Option.some("parked"));
    }),
  );

  effect("gives timed-out for a kept wait past its timeout", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });
      store.seed(ITEM, asPhase(P.issue.proposed), OTHER, {
        data: asData({ since: "2026-01-01T00:00:00.000Z" }),
      });

      const ran = yield* inWorkflow(
        Phases.recordParking({ ...WAIT, timeout: Duration.hours(1) }),
        store.service,
      );

      expect(ran.result).toEqual(Option.some("timed-out"));
    }),
  );
});

describe("Phases.fitsAPark", () => {
  test("is true for data with room left for the since a park adds", () => {
    expect(Phases.fitsAPark({})).toBe(true);
    expect(Phases.fitsAPark({ round: 2 })).toBe(true);
  });

  test("is false for data a record could take, but not with a since beside it", () => {
    // {"pad":"…"} at exactly the most a record's data may take.
    const full = { pad: "x".repeat(PHASE_DATA_MAX_BYTES - '{"pad":""}'.length) };

    expect(Phases.fitsAPark({ pad: full.pad.slice(40) })).toBe(true);
    expect(Phases.fitsAPark(full)).toBe(false);
  });
});

describe("Phases.advanceRun", () => {
  const advancing = (node: Option.Option<NodeAt>) =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });

      const ran = yield* inWorkflow(
        Phases.advanceRun("triaged").pipe(
          Effect.provideService(Phases.RecordedOn, Option.some(ITEM)),
          Effect.provideService(CurrentNode, node),
          Effect.as("advanced"),
        ),
        store.service,
      );

      expect(store.phases()[ITEM]).toBe("triaged");

      return ran.steps;
    });

  effect("records in a step named for the phase outside a plan's node", () =>
    Effect.gen(function* () {
      expect(yield* advancing(Option.none())).toEqual(["progress-triaged"]);
    }),
  );

  effect("records in a step named for the node, its round and its lane", () =>
    Effect.gen(function* () {
      expect(
        yield* advancing(Option.some({ id: "ci", round: Option.some(2), lane: Option.none() })),
      ).toEqual(["progress-ci-2"]);
      expect(
        yield* advancing(
          Option.some({ id: "ci", round: Option.some(12), lane: Option.some("task-10") }),
        ),
      ).toEqual(["progress-ci-12-task-10"]);
      expect(
        yield* advancing(Option.some({ id: "ci", round: Option.none(), lane: Option.none() })),
      ).toEqual(["progress-ci"]);
    }),
  );

  effect("records nothing outside a document's run", () =>
    Effect.gen(function* () {
      const store = progressStore({ checked: false });

      const ran = yield* inWorkflow(
        Phases.advanceRun("triaged").pipe(Effect.as("advanced")),
        store.service,
      );

      expect(ran.result).toEqual(Option.some("advanced"));
      expect(store.phases()).toEqual({});
    }),
  );
});
