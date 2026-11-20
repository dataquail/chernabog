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
  type WorkItem,
} from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import addressReview from "../packages/recipes/flows/address-review.ts";
import { anomaliesReportOf, reportOf } from "../src/interface/cli/progress.main.ts";
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
  fake.comment(
    'Implemented by claude for #3. <!-- chernabog-session {"adapter":"claude","sessionId":"implement-session","issue":3,"branch":"auto/issue-3"} -->',
  );
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
      fake.recordPhase(PR_ITEM, Phases.awaitingCi(2), { by: "mallory" });

      const items = yield* found(fake, flow());

      expect(startable(items)).toEqual([]);
      expect(items.map((one) => [one.key.startsWith(`${PR_ITEM}-anomaly-`), one.data])).toEqual([
        [true, { anomaly: PR_ITEM }],
      ]);
      expect<unknown>(heldOf(items)).toEqual([
        expect.stringContaining("(none -> awaiting-ci-2, by mallory) is an anomaly"),
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
      expect(
        passes(kindItem[observed.item], recordOf({ phase: observed.to, by: observed.by })),
      ).toEqual(Option.none());
    }

    expect(
      passes(
        PR_ITEM,
        recordOf({
          phase: P.approved,
          from: Option.some("awaiting-ci-3"),
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

  test("backfill writes only first records", () => {
    expect(
      passes(
        PR_ITEM,
        recordOf({ phase: P.approved, from: Option.some(P.reviewAsked), by: Backfill.WRITER }),
      ),
    ).toEqual(
      Option.some(
        expect.stringContaining(
          "observer:backfill records only pull-request review-asked from none",
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

describe("chernabog progress anomalies' report", () => {
  const anomaly = {
    item: PR_ITEM,
    phase: "changes-asked",
    by: "mallory",
    version: "0123456789abcdef",
    why: "its writer, mallory, is none of the repo's personas, a run or an observer chernabog writes as",
  };

  test("names each record, and how to fix it", () => {
    expect(
      anomaliesReportOf(
        { repo: "demo", personas: PERSONAS, anomalies: [anomaly], acknowledged: [], moved: [] },
        false,
      ),
    ).toEqual([
      `${PR_ITEM}: record 0123456 (none -> changes-asked, by mallory): its writer, mallory, is none of the repo's personas, a run or an observer chernabog writes as`,
      "Each one's item is held until its record is fixed: record the phase again as a persona, or run it again with --acknowledge to record each one's phase again as it is.",
    ]);
  });

  test("says which it acknowledged, and which moved first", () => {
    expect<unknown>(
      anomaliesReportOf(
        {
          repo: "demo",
          personas: PERSONAS,
          anomalies: [anomaly, { ...anomaly, item: "issue-3" }],
          acknowledged: [PR_ITEM],
          moved: ["issue-3"],
        },
        true,
      ),
    ).toEqual([
      expect.stringMatching(new RegExp(`^acknowledged ${PR_ITEM}: record 0123456`)),
      "left issue-3: its record moved after the survey read it",
    ]);
  });

  test("says when every record passes", () => {
    expect(
      anomaliesReportOf(
        { repo: "demo", personas: PERSONAS, anomalies: [], acknowledged: [], moved: [] },
        false,
      ),
    ).toEqual(["demo: every record passes the check"]);
  });

  test("warns first when the repo lists no personas, since every persona's record is then an anomaly", () => {
    expect(
      anomaliesReportOf(
        { repo: "demo", personas: [], anomalies: [], acknowledged: [], moved: [] },
        false,
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
