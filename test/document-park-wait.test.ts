// A flow document's waits on a person and on a red base in a CI job (audit
// W8, ADR 0021 decision 4), as document-park-ci.test.ts checks its waits for
// CI. A daemon's run or a CI job's ends at the park, so plan.awaitAnswer adds
// the node it parked at to the spec's proposed record, whose round is the
// repeat's, and pr.land to the pull request's merge-held record. The
// document's own source offers the item again once a person answers, or the
// base is green, or the wait runs out, and the new run starts at that node:
// in the plan's round it parked in, with the plan read back from the blob
// the record names.

import {
  type CiState,
  DEFAULT_LABELS,
  type Flow,
  type Json,
  Plan,
  PullRequest,
  Resume,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { mayStart } from "../src/modules/runs/domain/run/work-item.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import {
  documentOf,
  loadFlow,
  PLAN_DOCUMENT,
  RE_REVIEW_DOCUMENT,
  REVIEW_DOCUMENT,
} from "./compose-harness.ts";
import { effect } from "./effect-test.ts";
import {
  type EngineRun,
  type Fake,
  flowTriggered,
  HEAD,
  ISSUE,
  item,
  makeFake,
  PULL,
  repo,
  runToEnd,
  runUntil,
  summaryOf,
} from "./sdk-fakes.ts";

// The engine runs below take milliseconds alone, but under the whole suite's
// load the engine's runner can miss health checks for seconds, as
// document-park-ci's do.
const ENGINE_TIMEOUT = 60_000;

const SPEC_ITEM = `issue-${ISSUE}`;
const PR_ITEM = `pr-${PULL}`;
const LONG_AGO = DateTime.makeUnsafe("2026-01-01T00:00:00Z");

const Parked = Schema.Struct({
  resume: Schema.Struct({
    flow: Schema.String,
    node: Schema.String,
    login: Schema.String,
    item: Schema.Json,
    kept: Schema.Record(Schema.String, Schema.Json),
  }),
});

// The record's data as it is, to read or to seed another fake's record with.
const rawData = (fake: Fake, name: string) =>
  Option.getOrThrow(
    Option.flatMap(Option.fromUndefinedOr(fake.records().get(name)), (record) => record.data),
  );

const parkedOf = (fake: Fake, name: string) =>
  Schema.decodeUnknownSync(Parked)(rawData(fake, name)).resume;

// Whether the run waits on `signal`, under the deferred `deferred`.
const waitsOn = (signal: string, deferred: string) => (run: EngineRun) =>
  Effect.map(listRunWaitsHandler({ runId: run.id, signal }), ({ waits }) =>
    waits.some((wait) => wait.deferred === `${signal}:${deferred}`),
  );

// The items a document's trigger offers to resume, by its record.
const resumes = (fake: Fake, flow: Flow, settings: { readonly [key: string]: Json } = {}) =>
  flowTriggered(fake, flow, settings).pipe(
    Effect.map((items) => items.filter((found) => Option.isSome(Resume.resumedAt(found)))),
    Effect.orDie,
  );

const onlyResume = (fake: Fake, flow: Flow, settings: { readonly [key: string]: Json } = {}) =>
  Effect.flatMap(resumes(fake, flow, settings), (items) => Effect.fromOption(Arr.head(items))).pipe(
    Effect.orDie,
  );

describe("the plan document in a CI job", () => {
  const loaded = loadFlow(documentOf(PLAN_DOCUMENT));
  const work = item(SPEC_ITEM, { issue: ISSUE, label: Plan.LABELS.plan });

  const task = (key: string, kind: string, blockedBy: ReadonlyArray<string> = []) => ({
    key,
    title: `Do ${key}`,
    body: `What ${key} is.`,
    kind,
    blockedBy: [...blockedBy],
  });

  const NODES = [task("api-schema", "auto"), task("api", "hybrid", ["api-schema"])];
  const SUMMARY = "The schema first, then the API on it.";
  const PLAN: Json = { status: "plan", summary: SUMMARY, nodes: NODES };

  const queued = () => {
    const fake = makeFake("approve", { ciJob: true });
    fake.setLabels(ISSUE, [Plan.LABELS.plan]);
    fake.plans.push(PLAN);

    return fake;
  };

  // Runs the document on a queued spec until it parks on round 1's plan, then
  // lets go of every claim, as a run ending at its park does.
  const parked = (flow: Flow) =>
    Effect.gen(function* () {
      const fake = queued();
      const handle = flowHandle(repo, "plan", flow);
      const run = yield* runUntil(handle, fake, work, waitsOn("approved", "plan-1"));
      fake.refs.clear();

      return { fake, run };
    });

  // A fake as a run that parked on round `round`'s plan, written `at`, leaves
  // it: the plan's comment, and the spec's record as `from`'s, in that round,
  // naming the blob that keeps NODES.
  const parkedIn = (from: Fake, round: number, at: DateTime.Utc) => {
    const fake = makeFake("approve", { ciJob: true });
    fake.setLabels(ISSUE, [DEFAULT_LABELS.inProgress, Plan.LABELS.proposed]);
    fake.comment(Plan.planComment(round, SUMMARY, Schema.decodeSync(Plan.Plan)(NODES)));
    const data = rawData(from, SPEC_ITEM);
    const resume = Schema.decodeUnknownSync(Parked)(data).resume;
    const blob = Plan.planBlob(NODES);

    fake.recordPhase(SPEC_ITEM, "proposed", {
      at,
      data: {
        ...data,
        round,
        plan: blob.hash,
        after: 0,
        resume: { ...resume, kept: { proposed: { issue: ISSUE, round } } },
      },
      blobs: [blob.text],
    });

    return fake;
  };

  effect(
    "adds the node it parked at to the spec's proposed record, which keeps its round",
    () =>
      Effect.gen(function* () {
        const flow = yield* loaded;
        const { fake, run } = yield* parked(flow);

        expect(run.status).toBe("running");
        expect(fake.phases()[SPEC_ITEM]).toBe("proposed");

        const data = rawData(fake, SPEC_ITEM);
        const resume = parkedOf(fake, SPEC_ITEM);
        expect([data.round, data.within, resume.flow, resume.node]).toEqual([
          1,
          "14 days",
          "plan",
          "answer",
        ]);
        // The plan isn't kept in the node's resume: its spec and round are,
        // and a run that takes it up reads it back from the blob the record
        // names, which the wait carried on from plan.propose's record.
        expect(resume.kept).toEqual({ proposed: { issue: ISSUE, round: 1 } });
        expect(fake.records().get(SPEC_ITEM)?.blobs).toEqual([String(data.plan)]);

        // Nobody has answered: held, with why.
        expect((yield* resumes(fake, flow)).map((found) => found.held)).toEqual([
          "waits on a person's answer to the plan of round 1",
        ]);

        // A person asks for changes: work a run may start, at the node, in round 1.
        fake.comment("Split the API in two.", "zach");
        const asked = yield* onlyResume(fake, flow);
        expect(mayStart(asked)).toBe(true);
        expect(Option.map(Resume.resumedAt(asked), (at) => [at.node, at.round, at.phase])).toEqual(
          Option.some(["answer", 1, "proposed"]),
        );
      }),
    ENGINE_TIMEOUT,
  );

  effect(
    "a new run takes up a plan approved in round 2 and makes the epic, without drafting again",
    () =>
      Effect.gen(function* () {
        const flow = yield* loaded;
        const { fake: before } = yield* parked(flow);
        const fake = parkedIn(before, 2, yield* DateTime.now);
        fake.setLabels(ISSUE, [...fake.labelsOf(ISSUE), Plan.LABELS.approved]);

        const resumed = yield* onlyResume(fake, flow);
        expect(Option.map(Resume.resumedAt(resumed), (at) => at.round)).toEqual(Option.some(2));

        const finished = yield* runToEnd(flowHandle(repo, "plan", flow), fake, resumed);

        expect(finished.status).toBe("done");
        expect(summaryOf(finished)).toBe(`#${ISSUE}: an epic of 2 sub-issues`);
        expect(fake.requests).toEqual([]);
        expect(fake.graph.made.size).toBe(2);
        expect(fake.phases()[SPEC_ITEM]).toBe("became-epic");
        expect(yield* resumes(fake, flow)).toEqual([]);
      }),
    ENGINE_TIMEOUT,
  );

  effect(
    "a new run takes up changes asked in round 2 and drafts round 3",
    () =>
      Effect.gen(function* () {
        const flow = yield* loaded;
        const { fake: before } = yield* parked(flow);
        const fake = parkedIn(before, 2, yield* DateTime.now);
        fake.comment("Split the API in two.", "zach");
        fake.plans.push(PLAN);

        const run = yield* runUntil(
          flowHandle(repo, "plan", flow),
          fake,
          yield* onlyResume(fake, flow),
          waitsOn("approved", "plan-3"),
        );

        expect(run.status).toBe("running");
        // One draft, round 3's, with what the person asked for.
        expect(fake.requests).toHaveLength(1);
        expect(fake.requests[0]?.prompt).toContain("Split the API in two.");

        const data = rawData(fake, SPEC_ITEM);
        expect([data.round, parkedOf(fake, SPEC_ITEM).node]).toEqual([3, "answer"]);
      }),
    ENGINE_TIMEOUT,
  );

  effect(
    "once nobody answered in time, a new run hands the spec to a person",
    () =>
      Effect.gen(function* () {
        const flow = yield* loaded;
        const { fake: before } = yield* parked(flow);
        const fake = parkedIn(before, 2, LONG_AGO);

        const due = yield* onlyResume(fake, flow);
        expect(mayStart(due)).toBe(true);

        const finished = yield* runToEnd(flowHandle(repo, "plan", flow), fake, due);

        expect(finished.status).toBe("needs-human");
        expect(summaryOf(finished)).toContain("nobody answered the plan within 14 days");
        expect(fake.requests).toEqual([]);
        expect(fake.graph.made.size).toBe(0);
        expect(fake.labelsOf(ISSUE)).toContain(DEFAULT_LABELS.needsHuman);
        expect(yield* resumes(fake, flow)).toEqual([]);
      }),
    ENGINE_TIMEOUT,
  );
});

describe("pr.land's merge hold in a CI job", () => {
  const SHIP = "auto:ship";
  const RED: CiState = { state: "red", failedChecks: ["test"] };
  const GREEN: CiState = { state: "green" };
  const HOLDING = { holdMergesOnBrokenBase: true, mergeHoldTimeout: "1 day" };
  const loaded = loadFlow(documentOf(REVIEW_DOCUMENT));
  const REVIEWED = { pullRequest: PULL, headRef: `auto/issue-${ISSUE}`, agentWritten: true };
  const work = item(PR_ITEM, REVIEWED);

  // A repo whose config.yaml holds merges on a red base.
  const holding = (flow: Flow, name = "review") =>
    flowHandle(
      { ...repo, personas: Arr.map(repo.personas, (persona) => ({ ...persona, shared: HOLDING })) },
      name,
      flow,
    );

  // Runs the review document on an auto:ship pull request until it holds the
  // merge for a red base, then lets go of every claim.
  const parked = (flow: Flow) =>
    Effect.gen(function* () {
      const fake = makeFake("approve", { ciJob: true });
      fake.setLabels(PULL, [DEFAULT_LABELS.needsReview, SHIP]);
      fake.merge.baseCi = Option.some(RED);

      const run = yield* runUntil(
        holding(flow),
        fake,
        work,
        waitsOn(PullRequest.BASE_GREEN, `merge-pr-${PULL}-1`),
      );

      fake.refs.clear();

      return { fake, run };
    });

  // An auto:ship pull request a run approved in a CI job that has ended.
  const approvedEarlier = () => {
    const fake = makeFake("approve", { ciJob: true });
    fake.recordReview({ sha: HEAD, round: 1, verdict: "approve" });
    fake.setLabels(PULL, [SHIP]);

    return fake;
  };

  // A fake whose pull request's record is the one `from` held with, written `at`.
  const heldAt = (from: Fake, base: CiState, at: DateTime.Utc) => {
    const fake = approvedEarlier();
    fake.merge.baseCi = Option.some(base);
    fake.recordPhase(PR_ITEM, "merge-held", { at, data: rawData(from, PR_ITEM) });

    return fake;
  };

  effect(
    "adds the node it parked at to the merge-held record, beside the work item that holds it",
    () =>
      Effect.gen(function* () {
        const flow = yield* loaded;
        const { fake, run } = yield* parked(flow);

        expect(run.status).toBe("running");
        expect(fake.phases()[PR_ITEM]).toBe("merge-held");

        const data = rawData(fake, PR_ITEM);
        const resume = parkedOf(fake, PR_ITEM);
        expect([data.key, data.pullRequest, resume.flow, resume.node]).toEqual([
          PR_ITEM,
          PULL,
          "review",
          "land",
        ]);
        expect(Object.keys(resume.kept)).toEqual(["review"]);

        // Still red, with time left: held, with why.
        expect((yield* resumes(fake, flow, HOLDING)).map((found) => found.held)).toEqual([
          `holds the merge of #${PULL}: CI on main is red`,
        ]);
      }),
    ENGINE_TIMEOUT,
  );

  effect(
    "once the base is green, a new run merges it without reviewing again",
    () =>
      Effect.gen(function* () {
        const flow = yield* loaded;
        const { fake: before } = yield* parked(flow);
        const fake = heldAt(before, GREEN, yield* DateTime.now);

        const resumed = yield* onlyResume(fake, flow, HOLDING);
        expect([resumed.key, mayStart(resumed)]).toEqual([PR_ITEM, true]);

        const finished = yield* runToEnd(holding(flow), fake, resumed);

        expect(finished.status).toBe("done");
        expect(fake.merge.requests).toEqual([{ method: "squash", sha: HEAD }]);
        expect(fake.requests).toEqual([]);
      }),
    ENGINE_TIMEOUT,
  );

  effect(
    "held past mergeHoldTimeout, a new run hands it to a person without merging",
    () =>
      Effect.gen(function* () {
        const flow = yield* loaded;
        const { fake: before } = yield* parked(flow);
        const fake = heldAt(before, RED, LONG_AGO);

        const due = yield* onlyResume(fake, flow, HOLDING);
        expect(mayStart(due)).toBe(true);

        yield* runToEnd(holding(flow), fake, due);

        expect(fake.merge.requests).toEqual([]);
        expect(fake.requests).toEqual([]);
        expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.needsHuman);
        expect(
          fake.comments.some((comment) => comment.body.includes("CI on main stayed red for 1d")),
        ).toBe(true);
        // Handed to a person: nothing is left to take up.
        expect(yield* resumes(fake, flow, HOLDING)).toEqual([]);
      }),
    ENGINE_TIMEOUT,
  );

  effect(
    "re-review's document resumes at the land of the branch it parked in",
    () =>
      Effect.gen(function* () {
        const flow = yield* loadFlow(documentOf(RE_REVIEW_DOCUMENT));
        const { fake: before } = yield* parked(yield* loaded);
        const data = rawData(before, PR_ITEM);
        const resume = parkedOf(before, PR_ITEM);
        const fake = approvedEarlier();
        fake.merge.baseCi = Option.some(GREEN);

        // As re-review's recheck parked it: its own flow, node and work item.
        fake.recordPhase(PR_ITEM, "merge-held", {
          at: yield* DateTime.now,
          data: {
            ...data,
            key: `${PR_ITEM}-again`,
            resume: {
              ...resume,
              flow: "re-review",
              node: "landed",
              item: { key: `${PR_ITEM}-again`, data: REVIEWED },
              kept: { recheck: { verdict: "approve", round: 2 } },
            },
          },
        });

        const resumed = yield* onlyResume(fake, flow, HOLDING);
        const finished = yield* runToEnd(holding(flow, "re-review"), fake, resumed);

        expect(finished.status).toBe("done");
        expect(fake.merge.requests).toEqual([{ method: "squash", sha: HEAD }]);
        expect(fake.requests).toEqual([]);
        // The review document's runs don't take it up.
        expect(yield* resumes(fake, yield* loaded, HOLDING)).toEqual([]);
      }),
    ENGINE_TIMEOUT,
  );
});
