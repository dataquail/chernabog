// The ledger's tamper evidence (ADR 21, decision 5): before a source acts on
// a phase record, the record's writer must be one chernabog knows and its
// transition one the catalogue declares. A record that fails is an anomaly:
// the source doesn't act on it, and the item is held for a person with the
// record named. These sabotage the record each way a person, or an old
// version of chernabog, could, and check the catalogue knows every
// transition the shipped recipes and documents make.

import {
  Backfill,
  Blocks,
  Compose,
  type Flow,
  Ledger,
  Phase,
  type PhaseRecord,
  Phases,
  PhaseWriter,
  reviewMarker,
  UNREADABLE_PHASE,
  UNREADABLE_WRITER,
  type WorkItem,
} from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import addressReview from "../packages/recipes/flows/address-review.ts";
import { anomaliesReportOf, reportOf } from "../src/interface/cli/progress.main.ts";
import { parseSeen } from "../src/modules/runs/runs.platform.ts";
import {
  ADDRESS_REVIEW_DOCUMENT,
  documentOf,
  EPIC_DOCUMENT,
  HUMAN_INITIATED_DOCUMENT,
  IMPLEMENT_DOCUMENT,
  loadFlow,
  PLAN_DOCUMENT,
  POST_MERGE_DOCUMENT,
  RE_REVIEW_DOCUMENT,
  READY_DOCUMENT,
  RESOLVE_CONFLICTS_DOCUMENT,
  REVIEW_DOCUMENT,
  REVIEW_WITH_STAGE_DOCUMENT,
} from "./compose-harness.ts";
import { effect } from "./effect-test.ts";
import { registerLedgerCheck } from "./ledger-checked.preload.ts";
import { EARLIER_RUN, progressStore } from "./progress-fake.ts";
import { type Fake, flowTriggered, HEAD, makeFake, onFake, PULL } from "./sdk-fakes.ts";

const PR_ITEM = Phases.pullRequestItem(PULL);
const P = Phases.PHASES.pullRequest;

const asPhase = Schema.decodeSync(Phase);
const asWriter = Schema.decodeSync(PhaseWriter);

// A record as an adapter would give it, with the phase, its writer and what it moved from.
const recordOf = (record: {
  readonly phase: string;
  readonly by: string;
  readonly from?: Option.Option<string>;
}): PhaseRecord => ({
  phase: asPhase(record.phase),
  from: Option.map(record.from ?? Option.none(), asPhase),
  by: asWriter(record.by),
  version: "0123456789abcdef",
  at: DateTime.makeUnsafe(0),
  data: Option.none(),
  blobs: [],
});

// A pull request this persona wrote, whose latest review asks for changes on
// its head: address-review's work, once its record says changes asked.
const changesAsked = () => {
  const fake = makeFake("approve", { ciJob: true });
  fake.submitted.push({ author: "data-quail", state: "CHANGES_REQUESTED", commitSha: HEAD });
  fake.comment(
    reviewMarker.write({
      sha: HEAD,
      round: 1,
      verdict: "request-changes",
      reviewer: "data-quail",
      sessionId: "review-session",
      adapter: "codex",
    }),
  );
  fake.handedOff({
    adapter: "claude",
    sessionId: "implement-session",
    issue: 3,
    branch: "auto/issue-3",
  });
  fake.git.pushes = 1;

  return fake;
};

const PERSONAS = ["chernabog-bot"];

// What address-review's trigger finds, in a repo whose personas, by its
// committed config, are PERSONAS (the fake's).
const found = <E, R>(fake: Fake, flow: Effect.Effect<Flow, E, R>) =>
  Effect.flatMap(flow, (loaded) => flowTriggered(fake, loaded).pipe(Effect.orDie));

const startable = (items: ReadonlyArray<WorkItem>) =>
  items.filter(
    (one) =>
      Option.isNone(Option.fromUndefinedOr(one.held)) &&
      one.wakeOnly !== true &&
      Option.isNone(Option.fromUndefinedOr(one.elsewhere)) &&
      Option.isNone(Option.fromUndefinedOr(one.waitsOn)),
  );

// Each held item's reason, by its key.
const heldOf = (items: ReadonlyArray<WorkItem>) =>
  items.flatMap((one) => Option.toArray(Option.fromUndefinedOr(one.held)));

const recipe = Effect.succeed(addressReview);

// The flows each way: the recipe and its document, which must behave alike.
const FLOWS = [
  ["the recipe", () => Effect.succeed(addressReview)],
  ["the document", () => loadFlow(documentOf(ADDRESS_REVIEW_DOCUMENT))],
] as const;

describe.each(FLOWS)("sabotage of address-review's record, in %s", (_, flow) => {
  effect("a run's record is acted on: the control", () =>
    Effect.gen(function* () {
      const fake = changesAsked();
      fake.recordPhase(PR_ITEM, P.changesAsked);

      const items = yield* found(fake, flow());

      expect<unknown>(startable(items).map((one) => one.key)).toEqual([
        expect.stringMatching(new RegExp(`^${PR_ITEM}-changes-asked-`)),
      ]);
      expect(heldOf(items)).toEqual([]);
    }),
  );

  effect("a record a person committed to the thread is held, with the record named", () =>
    Effect.gen(function* () {
      const fake = changesAsked();
      fake.recordPhase(PR_ITEM, P.changesAsked, { by: "mallory" });
      const version = fake.records().get(PR_ITEM)?.version ?? "";

      const items = yield* found(fake, flow());

      expect(startable(items)).toEqual([]);
      expect(heldOf(items)).toEqual([
        `${PR_ITEM}'s record ${version.slice(0, 7)} (none -> changes-asked, by mallory) is an anomaly: its writer, mallory, is none of the repo's personas, a run or an observer chernabog writes as. Record its phase again as a persona, or acknowledge it with chernabog progress anomalies --acknowledge`,
      ]);
      // Not acted on: the record is the person's still, not reconciled over.
      expect(fake.records().get(PR_ITEM)?.by).toBe(asWriter("mallory"));
    }),
  );

  // A record the adapter couldn't read (#549), such as a commit pushed to the
  // thread with no Phase trailer, holds its own item and no other.
  effect("a record the adapter couldn't read is held, with why", () =>
    Effect.gen(function* () {
      const fake = changesAsked();
      fake.recordPhase(PR_ITEM, UNREADABLE_PHASE, {
        by: UNREADABLE_WRITER,
        data: { unreadable: "it has no Phase trailer" },
      });
      const version = fake.records().get(PR_ITEM)?.version ?? "";

      const items = yield* found(fake, flow());

      expect(startable(items)).toEqual([]);
      expect(heldOf(items)).toEqual([
        `${PR_ITEM}'s record ${version.slice(0, 7)} is an anomaly: it doesn't read as a record (it has no Phase trailer). Record its phase again as a persona: acknowledging it can't, since it holds no phase`,
      ]);
    }),
  );

  effect("a known writer's transition that no flow declares is held", () =>
    Effect.gen(function* () {
      const fake = changesAsked();
      fake.recordPhase(PR_ITEM, P.reviewAsked);
      // review.requestedAgain's observer records review-asked-again, never changes-asked.
      fake.recordPhase(PR_ITEM, P.changesAsked, { by: "observer:review.requestedAgain" });

      const items = yield* found(fake, flow());

      expect(startable(items)).toEqual([]);
      expect<unknown>(heldOf(items)).toEqual([
        expect.stringContaining(
          "(review-asked -> changes-asked, by observer:review.requestedAgain) is an anomaly: observer:review.requestedAgain records only pull-request review-asked-again from",
        ),
      ]);
    }),
  );

  effect("a run's record of a phase no pull request has is held", () =>
    Effect.gen(function* () {
      const fake = changesAsked();
      fake.recordPhase(PR_ITEM, P.changesAsked);
      // An epic's phase, on a pull request, moving it off the one address-review reads.
      fake.recordPhase(PR_ITEM, Phases.PHASES.epic.waiting);

      const items = yield* found(fake, flow());

      expect(startable(items)).toEqual([]);
      expect<unknown>(heldOf(items)).toEqual([
        expect.stringContaining(
          "(changes-asked -> waiting, by 00000000-0000-4000-8000-000000000001) is an anomaly: waiting isn't a phase of a pull-request",
        ),
      ]);
      expect(fake.phases()[PR_ITEM]).toBe("waiting");
    }),
  );

  effect("a renamed persona's old record is held; the persona's own passes", () =>
    Effect.gen(function* () {
      const old = changesAsked();
      old.recordPhase(PR_ITEM, P.changesAsked, { by: "old-bot" });

      const oldItems = yield* found(old, flow());

      expect(startable(oldItems)).toEqual([]);
      expect<unknown>(heldOf(oldItems)).toEqual([
        expect.stringContaining("by old-bot) is an anomaly: its writer, old-bot, is none"),
      ]);

      const current = changesAsked();
      current.recordPhase(PR_ITEM, P.changesAsked, { by: "Chernabog-Bot" });

      expect(startable(yield* found(current, flow())).length).toBe(1);
    }),
  );

  effect("a forged park on a phase the flow reads is held alone, though nothing reports it", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve", { ciJob: true });
      fake.recordPhase(PR_ITEM, Phases.inRound(Phases.PHASES.pullRequest.awaitingFixCi, 2), {
        by: "mallory",
      });

      const items = yield* found(fake, flow());

      expect(startable(items)).toEqual([]);
      expect(items.map((one) => [one.key.startsWith(`${PR_ITEM}-anomaly-`), one.data])).toEqual([
        [true, { anomaly: PR_ITEM }],
      ]);
      expect<unknown>(heldOf(items)).toEqual([
        expect.stringContaining("(none -> awaiting-fix-ci-2, by mallory) is an anomaly"),
      ]);
    }),
  );

  effect("the same anomaly says the same on every tick, and the tick goes on", () =>
    Effect.gen(function* () {
      const fake = changesAsked();
      fake.recordPhase(PR_ITEM, P.changesAsked, { by: "mallory" });
      const comments = fake.comments.length;

      const first = yield* found(fake, flow());
      const second = yield* found(fake, flow());

      expect(second).toEqual(first);
      expect(fake.comments.length).toBe(comments);
    }),
  );
});

describe("a person's fix for an anomaly", () => {
  effect("the survey lists it, and acknowledging it lets the source act", () =>
    Effect.gen(function* () {
      const fake = changesAsked();
      fake.recordPhase(Phases.issueItem(3), Phases.PHASES.issue.handedOff);
      fake.recordPhase(PR_ITEM, P.changesAsked, { by: "mallory", data: { kept: true } });

      const anomalies = yield* onFake(fake, Ledger.survey);

      expect(anomalies.map((one) => [one.item, one.by, one.phase])).toEqual([
        [PR_ITEM, "mallory", "changes-asked"],
      ]);

      const acknowledged = yield* onFake(fake, Ledger.acknowledge(anomalies));

      expect(acknowledged.map((one) => one.acknowledged)).toEqual([true]);
      expect(fake.records().get(PR_ITEM)).toMatchObject({
        phase: "changes-asked",
        from: Option.some("changes-asked"),
        by: Ledger.ACKNOWLEDGED,
        data: Option.some({ kept: true }),
      });
      expect(yield* onFake(fake, Ledger.survey)).toEqual([]);
      expect(startable(yield* found(fake, recipe)).length).toBe(1);
    }),
  );

  effect("a record the adapter couldn't read is listed, and not acknowledged", () =>
    Effect.gen(function* () {
      const fake = changesAsked();
      fake.recordPhase(PR_ITEM, UNREADABLE_PHASE, {
        by: UNREADABLE_WRITER,
        data: { unreadable: "it has no Phase trailer" },
      });

      const anomalies = yield* onFake(fake, Ledger.survey);

      expect(anomalies.map((one) => [one.item, one.why])).toEqual([
        [PR_ITEM, "it doesn't read as a record (it has no Phase trailer)"],
      ]);

      const acknowledged = yield* onFake(fake, Ledger.acknowledge(anomalies));

      expect(acknowledged.map((one) => one.acknowledged)).toEqual([false]);
      expect(fake.records().get(PR_ITEM)?.by).toBe(asWriter(UNREADABLE_WRITER));
    }),
  );

  effect("a record that moved since the survey isn't acknowledged", () =>
    Effect.gen(function* () {
      const fake = changesAsked();
      fake.recordPhase(PR_ITEM, P.changesAsked, { by: "mallory" });
      const anomalies = yield* onFake(fake, Ledger.survey);
      fake.recordPhase(PR_ITEM, P.approved, { by: "mallory" });

      const acknowledged = yield* onFake(fake, Ledger.acknowledge(anomalies));

      expect(acknowledged.map((one) => one.acknowledged)).toEqual([false]);
      expect(fake.records().get(PR_ITEM)?.by).toBe(asWriter("mallory"));
    }),
  );

  // The compare-and-set is on the version the person saw: a record written
  // again since, at the same phase, by the same writer, is another record.
  effect("a record written again since, at the same phase, isn't acknowledged either", () =>
    Effect.gen(function* () {
      const fake = changesAsked();
      fake.recordPhase(PR_ITEM, P.changesAsked, { by: "mallory" });
      const anomalies = yield* onFake(fake, Ledger.survey);
      fake.recordPhase(PR_ITEM, P.changesAsked, { by: "mallory" });

      const acknowledged = yield* onFake(fake, Ledger.acknowledge(anomalies));

      expect(acknowledged.map((one) => one.acknowledged)).toEqual([false]);
      expect(fake.records().get(PR_ITEM)?.by).toBe(asWriter("mallory"));
    }),
  );

  effect("a record a persona writes again is an ordinary fix", () =>
    Effect.gen(function* () {
      const fake = changesAsked();
      fake.recordPhase(PR_ITEM, P.changesAsked, { by: "mallory" });
      fake.recordPhase(PR_ITEM, P.changesAsked);

      expect(startable(yield* found(fake, recipe)).length).toBe(1);
    }),
  );
});

describe("the catalogue of transitions", () => {
  const passes = (item: string, record: PhaseRecord) =>
    Ledger.anomalyIn(PERSONAS, item, record).pipe(Option.map((anomaly) => anomaly.why));

  const kindItem = { issue: "issue-3", "pull-request": PR_ITEM, epic: "epic-3" } as const;

  test("every phase a block records passes as a run's, from any phase of its kind", () => {
    for (const block of Object.values(Blocks.catalogue)) {
      for (const recorded of block.records) {
        for (const from of [Option.none(), ...Phases.phasesOf(recorded.item).map(Option.some)]) {
          expect([
            block.name,
            passes(
              kindItem[recorded.item],
              recordOf({ phase: recorded.phase, from, by: EARLIER_RUN }),
            ),
          ]).toEqual([block.name, Option.none()]);
        }
      }
    }
  });

  test("every reconcile a source declares passes as its observer's", () => {
    for (const source of Object.values(Blocks.sources)) {
      for (const reconciled of source.reconciles) {
        for (const from of reconciled.from) {
          const record = recordOf({
            phase: reconciled.to,
            from: Option.liftPredicate(from, (phase) => phase !== Phases.NO_RECORD),
            by: `observer:${source.name}`,
          });

          expect([source.name, from, passes(kindItem[reconciled.item], record)]).toEqual([
            source.name,
            from,
            Option.none(),
          ]);
        }
      }
    }
  });

  test("backfill's first records, review's own reconcile, and a later round's CI wait pass", () => {
    for (const observed of [...Backfill.OBSERVED]) {
      if (observed.from === "same") {
        continue;
      }

      for (const from of observed.from) {
        const read = Option.liftPredicate(from, (phase) => phase !== Phases.NO_RECORD);

        expect(
          passes(
            kindItem[observed.item],
            recordOf({ phase: observed.to, from: read, by: observed.by }),
          ),
        ).toEqual(Option.none());
      }
    }

    // Backfill moving a later round's wait off the old shared phase.
    expect(
      passes(
        PR_ITEM,
        recordOf({
          phase: "awaiting-fix-ci-2",
          from: Option.some("awaiting-ci-2"),
          by: Backfill.WRITER,
        }),
      ),
    ).toEqual(Option.none());

    // Backfill writes a pull request's phase again, copying a review marker's review in (#564).
    for (const phase of [P.approved, P.mergeHeld]) {
      expect(
        passes(PR_ITEM, recordOf({ phase, from: Option.some(phase), by: Backfill.WRITER })),
      ).toEqual(Option.none());
    }

    expect(
      passes(
        PR_ITEM,
        recordOf({
          phase: P.approved,
          from: Option.some("awaiting-fix-ci-3"),
          by: "observer:review.approved",
        }),
      ),
    ).toEqual(Option.none());
    expect(passes("issue-3", recordOf({ phase: "awaiting-ci-4", by: EARLIER_RUN }))).toEqual(
      Option.none(),
    );
    expect(passes(PR_ITEM, recordOf({ phase: "awaiting-conflict-ci-2", by: EARLIER_RUN }))).toEqual(
      Option.none(),
    );
  });

  test("a team's own phase, and any phase on a team's own item, pass as a run's", () => {
    expect(passes(PR_ITEM, recordOf({ phase: "qa-passed", by: EARLIER_RUN }))).toEqual(
      Option.none(),
    );
    expect(passes("release-7", recordOf({ phase: "waiting", by: EARLIER_RUN }))).toEqual(
      Option.none(),
    );
    expect(passes("release-7", recordOf({ phase: "waiting", by: "mallory" }))).not.toEqual(
      Option.none(),
    );
  });

  test("backfill writes only first records, and a pull request's phase again", () => {
    expect(
      passes(
        PR_ITEM,
        recordOf({ phase: P.approved, from: Option.some(P.reviewAsked), by: Backfill.WRITER }),
      ),
    ).toEqual(
      Option.some(
        expect.stringContaining(
          "observer:backfill records only a pull-request's phase again, pull-request review-asked from none",
        ),
      ),
    );
  });

  // What every shipped document, and each test document, records, as a run.
  const DOCUMENTS = [
    IMPLEMENT_DOCUMENT,
    REVIEW_DOCUMENT,
    READY_DOCUMENT,
    RE_REVIEW_DOCUMENT,
    ADDRESS_REVIEW_DOCUMENT,
    RESOLVE_CONFLICTS_DOCUMENT,
    POST_MERGE_DOCUMENT,
    HUMAN_INITIATED_DOCUMENT,
    PLAN_DOCUMENT,
    EPIC_DOCUMENT,
    REVIEW_WITH_STAGE_DOCUMENT,
  ];

  test("every phase each test document records passes, by the block or source that records it", () => {
    for (const source of DOCUMENTS) {
      const document = documentOf(source);

      for (const use of Compose.progressOf(document).records) {
        const by = Option.match(
          Option.fromUndefinedOr(Object.values(Blocks.sources).find((one) => one.name === use.by)),
          { onNone: () => EARLIER_RUN, onSome: (one) => `observer:${one.name}` },
        );

        const from = Option.match(
          Option.fromUndefinedOr(
            Object.values(Blocks.sources)
              .find((one) => one.name === use.by)
              ?.reconciles.find((reconciled) => reconciled.to === use.phase)?.from[0],
          ),
          {
            onNone: () => Option.none<string>(),
            onSome: (phase) => Option.liftPredicate(phase, (one) => one !== Phases.NO_RECORD),
          },
        );

        expect([
          document.flow,
          use.by,
          use.phase,
          passes(kindItem[use.item], recordOf({ phase: use.phase, from, by })),
        ]).toEqual([document.flow, use.by, use.phase, Option.none()]);
      }
    }
  });

  // The suite's every flow runs on this fake, so the test above is the
  // whole suite's: every recipe and document a test runs makes only
  // transitions the catalogue declares.
  effect(
    "the fake every flow's test runs on refuses a transition the catalogue doesn't declare",
    () =>
      Effect.gen(function* () {
        registerLedgerCheck();
        const store = progressStore();

        const exit = yield* store.service
          .advance(PR_ITEM, {
            from: Option.none(),
            to: asPhase(Phases.PHASES.epic.finished),
            by: asWriter(EARLIER_RUN),
          })
          .pipe(Effect.exit);

        expect(exit._tag).toBe("Failure");
        expect(store.records().size).toBe(0);
      }),
  );
});

// Each a record a person, or an old chernabog, could forge or misplace, which
// the check must report (#588: each kills a mutant of ledger-check.ts that
// survived every test before it).
describe("forged and misplaced records", () => {
  const whyOf = (personas: ReadonlyArray<string>, item: string, record: PhaseRecord) =>
    Ledger.anomalyIn(personas, item, record).pipe(Option.map((anomaly) => anomaly.why));

  const why = (item: string, record: PhaseRecord) => whyOf(PERSONAS, item, record);

  test("observer:acknowledged records only the phase again, never another transition", () => {
    expect(
      why(
        PR_ITEM,
        recordOf({ phase: P.approved, from: Option.some(P.changesAsked), by: Ledger.ACKNOWLEDGED }),
      ),
    ).toEqual(
      Option.some(
        "observer:acknowledged records only a issue's phase again, a pull-request's phase again, a epic's phase again, not changes-asked -> approved",
      ),
    );
    expect(why(PR_ITEM, recordOf({ phase: P.approved, by: Ledger.ACKNOWLEDGED }))).not.toEqual(
      Option.none(),
    );
    expect(
      why(
        PR_ITEM,
        recordOf({ phase: P.approved, from: Option.some(P.approved), by: Ledger.ACKNOWLEDGED }),
      ),
    ).toEqual(Option.none());
  });

  test("an observer's transition on another kind of item is reported", () => {
    // review.requestedAgain's observer records a pull request's review-asked-again.
    const record = recordOf({
      phase: P.reviewAskedAgain,
      from: Option.some(P.reviewAsked),
      by: "observer:review.requestedAgain",
    });

    expect(why(PR_ITEM, record)).toEqual(Option.none());
    expect(why("issue-3", record)).toEqual(
      Option.some(expect.stringContaining("not review-asked -> review-asked-again")),
    );
    expect(why("epic-3", record)).not.toEqual(Option.none());
  });

  test("an observer's declared transition passes on a team's own item", () => {
    expect(
      why(
        "release-7",
        recordOf({ phase: "shipped", from: Option.some("shipped"), by: Ledger.ACKNOWLEDGED }),
      ),
    ).toEqual(Option.none());
  });

  test("a multi-digit item is checked as its kind", () => {
    const misplaced = recordOf({ phase: Phases.PHASES.epic.waiting, by: EARLIER_RUN });

    expect(why("pr-73", misplaced)).toEqual(Option.some("waiting isn't a phase of a pull-request"));
    expect(Ledger.kindOf("pr-73")).toEqual(Option.some("pull-request"));
    expect(Ledger.kindOf("issue-120")).toEqual(Option.some("issue"));
    expect(Ledger.kindOf("epic-45")).toEqual(Option.some("epic"));
  });

  test("an item named like one, but not one, is a team's own", () => {
    const misplaced = recordOf({ phase: Phases.PHASES.epic.waiting, by: EARLIER_RUN });

    for (const item of ["pr-x7", "pr-7x", "pr-", "deploy12"]) {
      expect([item, Ledger.kindOf(item)]).toEqual([item, Option.none()]);
      expect([item, why(item, misplaced)]).toEqual([item, Option.none()]);
    }

    expect(why("deploy12", recordOf({ phase: P.changesAsked, by: EARLIER_RUN }))).toEqual(
      Option.none(),
    );
  });

  test("a writer that only contains a run's id is no run", () => {
    const record = (by: string) => recordOf({ phase: P.changesAsked, by });

    expect(why(PR_ITEM, record(EARLIER_RUN))).toEqual(Option.none());

    for (const by of [`x${EARLIER_RUN}`, `${EARLIER_RUN}x`]) {
      expect(why(PR_ITEM, record(by))).toEqual(
        Option.some(
          `its writer, ${by}, is none of the repo's personas, a run or an observer chernabog writes as`,
        ),
      );
    }
  });

  test("a run's phase of another kind is reported on an issue and on an epic", () => {
    const record = recordOf({ phase: P.changesAsked, by: EARLIER_RUN });

    expect(why("issue-12", record)).toEqual(Option.some("changes-asked isn't a phase of an issue"));
    expect(why("epic-12", record)).toEqual(Option.some("changes-asked isn't a phase of an epic"));
  });

  test("in a repo with two personas, each one's record passes", () => {
    const personas = ["chernabog-bot", "reviewer-bot"];

    for (const by of personas) {
      expect([by, whyOf(personas, PR_ITEM, recordOf({ phase: P.changesAsked, by }))]).toEqual([
        by,
        Option.none(),
      ]);
    }
  });
});

describe("what a checking trigger holds and reports", () => {
  // A trigger that reads every record, as a source that looks at every open
  // item does, and reports `items`.
  const reading = (items: ReadonlyArray<WorkItem>) => Effect.as(Phases.records, items);

  const checked = (
    fake: Fake,
    reads: ReadonlyArray<Phases.Reading>,
    items: ReadonlyArray<WorkItem> = [],
  ) => onFake(fake, Ledger.checking(Ledger.catalogue, reads)(reading(items)));

  const forged = (item: string, phase: string) => {
    const fake = makeFake("approve");
    fake.recordPhase(item, phase, { by: "mallory" });

    return { fake, version: fake.records().get(item)?.version ?? "" };
  };

  // Why a source holds an item for mallory's forged record of it.
  const heldFor = (item: string, version: string, phase: string) =>
    `${item}'s record ${version.slice(0, 7)} (none -> ${phase}, by mallory) is an anomaly: its writer, mallory, is none of the repo's personas, a run or an observer chernabog writes as. Record its phase again as a persona, or acknowledge it with chernabog progress anomalies --acknowledge`;

  effect("an anomaly on a kind or phase the flow doesn't read isn't reported", () =>
    Effect.gen(function* () {
      const { fake } = forged(PR_ITEM, P.changesAsked);

      for (const reads of [
        [],
        [{ item: "issue", phases: [P.changesAsked] }],
        [{ item: "pull-request", phases: [P.approved] }],
        [{ item: "pull-request", phases: [P.approved, P.reviewAsked] }],
      ] satisfies ReadonlyArray<ReadonlyArray<Phases.Reading>>) {
        expect([reads, yield* checked(fake, reads)]).toEqual([reads, []]);
      }
    }),
  );

  effect("an anomaly on a phase the flow reads is reported alone, held", () =>
    Effect.gen(function* () {
      const { fake, version } = forged(PR_ITEM, P.changesAsked);

      const reads: ReadonlyArray<Phases.Reading> = [
        { item: "pull-request", phases: [P.approved, P.changesAsked] },
      ];

      expect(yield* checked(fake, reads)).toEqual([
        {
          key: `${PR_ITEM}-anomaly-${version.slice(0, 7)}`,
          title: `${PR_ITEM}: an anomaly in its record`,
          data: { anomaly: PR_ITEM },
          held: heldFor(PR_ITEM, version, P.changesAsked),
        },
      ]);
    }),
  );

  effect("an anomaly whose record moved from a phase the flow reads is reported", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.recordPhase(PR_ITEM, P.reviewAsked);
      fake.recordPhase(PR_ITEM, P.changesAsked, { by: "mallory" });

      const items = yield* checked(fake, [{ item: "pull-request", phases: [P.reviewAsked] }]);

      expect(items.map((one) => one.data)).toEqual([{ anomaly: PR_ITEM }]);
    }),
  );

  // What a source reported is held by the anomaly of its pull request's
  // record, or its issue's, or its epic's, named; and not reported again alone.
  const reports = [
    ["a pull request", PR_ITEM, P.changesAsked, { pullRequest: PULL }],
    ["an issue", "issue-3", Phases.PHASES.issue.withPerson, { issue: 3 }],
    ["an epic", "epic-3", Phases.PHASES.epic.waiting, { issue: 3 }],
  ] as const;

  for (const [kind, item, phase, data] of reports) {
    effect(`an item a source reports is held by ${kind}'s anomaly, named`, () =>
      Effect.gen(function* () {
        const { fake, version } = forged(item, phase);
        const work = { key: "the-work", title: "the work", data };

        const items = yield* checked(
          fake,
          [{ item: Ledger.kindOf(item).pipe(Option.getOrThrow), phases: [phase] }],
          [work],
        );

        expect(items).toEqual([
          {
            ...work,
            held: heldFor(item, version, phase),
          },
        ]);
      }),
    );
  }

  test("an anomaly's key is its item's, with its record's short version", () => {
    expect(
      Ledger.anomalyKey({
        item: PR_ITEM,
        phase: P.changesAsked,
        by: "mallory",
        version: "0123456789abcdef",
        why: "forged",
      }),
    ).toBe("pr-7-anomaly-0123456");
  });

  test("a work item reports an anomaly alone only by its data's anomaly", () => {
    expect(Ledger.anomalyOfWork({ key: "k", data: { anomaly: PR_ITEM } })).toEqual(
      Option.some(PR_ITEM),
    );
    expect(Ledger.anomalyOfWork({ key: "k", data: { anomaly: 7 } })).toEqual(Option.none());
    expect(Ledger.anomalyOfWork({ key: "k", data: { pullRequest: PULL } })).toEqual(Option.none());
  });
});

describe("chernabog progress anomalies' report", () => {
  const anomaly = {
    item: PR_ITEM,
    phase: "changes-asked",
    by: "mallory",
    version: "0123456789abcdef",
    why: "its writer, mallory, is none of the repo's personas, a run or an observer chernabog writes as",
  };

  test("names each record as --acknowledge takes it back, and how to fix it", () => {
    expect(
      anomaliesReportOf(
        { repo: "demo", personas: PERSONAS, anomalies: [anomaly], acknowledged: [], moved: [] },
        [],
      ),
    ).toEqual([
      `${PR_ITEM}: record 0123456 (none -> changes-asked, by mallory): its writer, mallory, is none of the repo's personas, a run or an observer chernabog writes as [${PR_ITEM}@0123456]`,
      "Each one's item is held until its record is fixed: record the phase again as a persona, or, for one that is right as it is, run it again with --acknowledge <item>@<version> as listed, which records its phase again only while the record is still that one.",
    ]);
  });

  test("says which records it acknowledged, and which it left because they changed", () => {
    const seen = { item: PR_ITEM, version: "0123456" };
    const gone = { item: "issue-3", version: "fedcba9" };

    expect(
      anomaliesReportOf(
        {
          repo: "demo",
          personas: PERSONAS,
          anomalies: [anomaly],
          acknowledged: [seen],
          moved: [gone],
        },
        [seen, gone],
      ),
    ).toEqual([
      `acknowledged ${PR_ITEM}@0123456`,
      "left issue-3@fedcba9: the item's record is no longer that one, or passes the check now; list it again",
    ]);
  });

  test("reads a record as the listing names it", () => {
    expect(parseSeen("pr-184@9bf23c1")).toEqual(
      Option.some({ item: "pr-184", version: "9bf23c1" }),
    );
    expect(parseSeen("pr-184")).toEqual(Option.none());
  });

  test("says when every record passes", () => {
    expect(
      anomaliesReportOf(
        { repo: "demo", personas: PERSONAS, anomalies: [], acknowledged: [], moved: [] },
        [],
      ),
    ).toEqual(["demo: every record passes the check"]);
  });

  test("warns first when the repo lists no personas, since every persona's record is then an anomaly", () => {
    expect(
      anomaliesReportOf(
        { repo: "demo", personas: [], anomalies: [], acknowledged: [], moved: [] },
        [],
      ),
    ).toEqual([
      "warning: demo's .chernabog/config.yaml lists no personas:, so every record a persona wrote has an unknown writer, and is an anomaly. List the logins its flows run as under personas: (in the checkout, with --from-checkout) and run it again.",
      "demo: every record passes the check",
    ]);
  });
});

describe("chernabog progress backfill's report", () => {
  const empty = { repo: "demo", findings: [], written: [], lost: [] };

  test("warns first when the repo lists no personas, since the survey reads its logins from them", () => {
    expect(reportOf({ ...empty, personas: [] }, false)).toEqual([
      "warning: demo's .chernabog/config.yaml lists no personas:, so backfill misses a pull request that only a persona's review marks as automated, and every epic status comment. List the logins its flows run as under personas: (in the checkout, with --from-checkout) and run it again.",
      "demo: every open item that needs a record has one",
    ]);
  });

  test("says nothing of personas when the repo lists them", () => {
    expect(reportOf({ ...empty, personas: PERSONAS }, false)).toEqual([
      "demo: every open item that needs a record has one",
    ]);
  });
});
