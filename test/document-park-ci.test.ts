// A flow document parked in a CI job (audit W8, ADR 0021 decision 4): a
// daemon's run or a CI job's ends at the park, so a document's wait for CI
// records awaiting-ci on the run's item, with the node it parked at and what
// the steps from there on read (Resume). The document's own source offers the
// item again once CI has finished, as work a run may start, never only a
// wake, and the new run starts at that node, so nothing before it runs again.
// The epic document's rounds start from what its waiting record kept.

import {
  Blocks,
  Claims,
  DEFAULT_LABELS,
  Epic,
  type Flow,
  Implement,
  type LinkedIssue,
  Phases,
  Plan,
  Resume,
  reviewMarker,
  type WorkItem,
} from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { mayStart } from "../src/modules/runs/domain/run/work-item.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import {
  ADDRESS_REVIEW_DOCUMENT,
  documentOf,
  EPIC_DOCUMENT,
  IMPLEMENT_DOCUMENT,
  loadFlow,
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
// load the engine's runner can miss health checks for seconds, as plan-ci's
// and epic-ci's do.
const ENGINE_TIMEOUT = 60_000;

const ISSUE_ITEM = Phases.issueItem(ISSUE);
const PR_ITEM = Phases.pullRequestItem(PULL);
const PULL_URL = `https://github.com/dataquail/demo/pull/${PULL}`;
const POOL = { reviewers: ["zach", "data-quail"] };

const ParkedData = Schema.Struct({
  pullRequest: Schema.Finite,
  resume: Schema.Struct({
    flow: Schema.String,
    node: Schema.String,
    login: Schema.String,
    item: Schema.Struct({ key: Schema.String, data: Schema.Json }),
    kept: Schema.Record(Schema.String, Schema.Json),
  }),
});

// What the item's record keeps for the run that takes it up.
const parkedData = (fake: Fake, name: string) =>
  Option.flatMap(Option.fromUndefinedOr(fake.records().get(name)), (record) =>
    Option.flatMap(record.data, Schema.decodeUnknownOption(ParkedData)),
  );

// The record's data as it is, to seed another fake's record with.
const rawData = (fake: Fake, name: string) =>
  Option.getOrThrow(
    Option.flatMap(Option.fromUndefinedOr(fake.records().get(name)), (record) => record.data),
  );

// Whether the run waits on CI_SETTLED.
const waitsOnCi = (run: EngineRun) =>
  Effect.map(
    listRunWaitsHandler({ runId: run.id, signal: Implement.CI_SETTLED }),
    ({ waits }) => waits.length > 0,
  );

// The items a document's trigger offers to resume, by its record.
const resumes = (fake: Fake, flow: Flow) =>
  flowTriggered(fake, flow).pipe(
    Effect.map((items) => items.filter((found) => Option.isSome(Resume.resumedAt(found)))),
    Effect.orDie,
  );

const onlyResume = (fake: Fake, flow: Flow) =>
  Effect.flatMap(resumes(fake, flow), (items) => Effect.fromOption(Arr.head(items))).pipe(
    Effect.orDie,
  );

describe("the implement document in a CI job", () => {
  const loaded = loadFlow(documentOf(IMPLEMENT_DOCUMENT));
  const work = item(`issue-${ISSUE}`, { issue: ISSUE });

  const queuedInCi = () => {
    const fake = makeFake("approve", { ...POOL, ciJob: true });
    fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);

    return fake;
  };

  // Runs the document on a queued issue until it parks on its pull request's
  // pending CI, then lets go of every claim, as a run ending at its park does.
  const parked = (flow: Flow) =>
    Effect.gen(function* () {
      const fake = queuedInCi();
      fake.merge.ci = { state: "pending", waitingOn: ["test"] };
      const run = yield* runUntil(flowHandle(repo, "implement", flow), fake, work, waitsOnCi);
      fake.refs.clear();

      return { fake, run };
    });

  // A fake whose issue's record is the one `from` parked with, at `phase`.
  const seeded = (from: Fake, phase: string, data = rawData(from, ISSUE_ITEM)) => {
    const fake = makeFake("approve", { ...POOL, ciJob: true });
    fake.setLabels(ISSUE, [DEFAULT_LABELS.inProgress]);
    fake.git.opened = true;
    fake.recordPhase(ISSUE_ITEM, phase, { at: DateTime.makeUnsafe(0), data });

    return fake;
  };

  effect(
    "records the wait on the issue, with the node it parked at and what the steps after it read",
    () =>
      Effect.gen(function* () {
        const { fake, run } = yield* parked(yield* loaded);

        expect(run.status).toBe("running");
        expect(fake.git.opened).toBe(true);
        expect(fake.phases()[ISSUE_ITEM]).toBe("awaiting-ci");
        // Not handed off: nobody is asked to review it yet.
        expect(fake.people.requested).toEqual([]);

        const data = parkedData(fake, ISSUE_ITEM);
        expect(
          Option.map(data, (found) => ({
            pullRequest: found.pullRequest,
            flow: found.resume.flow,
            node: found.resume.node,
            item: found.resume.item,
            kept: Object.keys(found.resume.kept).toSorted(),
          })),
        ).toEqual(
          Option.some({
            pullRequest: PULL,
            flow: "implement",
            node: "ci",
            item: { key: `issue-${ISSUE}`, data: { issue: ISSUE } },
            // The worktree is made again, on whichever machine takes it up.
            kept: ["agent", "claim", "opened"],
          }),
        );
      }),
    ENGINE_TIMEOUT,
  );

  effect(
    "is held while CI pends, and offered as work a run may start once it finishes",
    () =>
      Effect.gen(function* () {
        const flow = yield* loaded;
        const { fake } = yield* parked(flow);

        const held = yield* resumes(fake, flow);
        expect(held.map((found) => [found.key, found.held])).toEqual([
          [`issue-${ISSUE}`, `waits on CI for #${PULL}`],
        ]);

        fake.merge.ci = { state: "green" };
        const ready = yield* onlyResume(fake, flow);

        expect(ready.key).toBe(`issue-${ISSUE}`);
        expect(Option.fromUndefinedOr(ready.held)).toEqual(Option.none());
        expect(Option.fromUndefinedOr(ready.wakeOnly)).toEqual(Option.none());
        expect(mayStart(ready)).toBe(true);
        expect(Option.map(Resume.resumedAt(ready), (at) => [at.node, at.phase])).toEqual(
          Option.some(["ci", "awaiting-ci"]),
        );
      }),
    ENGINE_TIMEOUT,
  );

  effect(
    "a new run starts at the node: it hands off without implementing or pushing again",
    () =>
      Effect.gen(function* () {
        const flow = yield* loaded;
        const { fake } = yield* parked(flow);
        const asked = fake.requests.length;
        const pushes = fake.git.pushes;

        fake.merge.ci = { state: "green" };
        const resumed = yield* onlyResume(fake, flow);
        const finished = yield* runToEnd(flowHandle(repo, "implement", flow), fake, resumed);

        expect(finished.status).toBe("done");
        expect(summaryOf(finished)).toBe(`#${ISSUE}: ${PULL_URL} is ready for review`);
        expect(fake.requests).toHaveLength(asked);
        expect(fake.git.pushes).toBe(pushes);
        expect(fake.people.requested).toHaveLength(1);
        expect(fake.phases()[ISSUE_ITEM]).toBe("handed-off");
        expect(fake.phases()[PR_ITEM]).toBe("review-asked");
        // Nothing is left to take up.
        expect(yield* resumes(fake, flow)).toEqual([]);
      }),
    ENGINE_TIMEOUT,
  );

  effect(
    "a new run on red CI fixes it in a worktree it makes again, from the round the record names",
    () =>
      Effect.gen(function* () {
        const flow = yield* loaded;
        const { fake: before } = yield* parked(flow);
        const fake = seeded(before, Phases.inRound(Phases.PHASES.issue.awaitingCi, 2));
        fake.merge.ci = { state: "red", failedChecks: ["test"] };
        fake.merge.afterPush = Option.some({ state: "green" });

        const resumed = yield* onlyResume(fake, flow);
        const finished = yield* runToEnd(flowHandle(repo, "implement", flow), fake, resumed);

        expect(finished.status).toBe("done");
        expect(fake.requests).toHaveLength(1);
        expect(fake.requests[0]?.cwd).toBe(`/tmp/demo-worktrees/auto/issue-${ISSUE}`);
        expect(fake.requests[0]?.prompt).toContain(`CI failed on pull request #${PULL}: test.`);
        expect(fake.steps.flatMap(Option.toArray)).toContain("fix-ci-2");
        expect(fake.phases()[ISSUE_ITEM]).toBe("handed-off");
      }),
    ENGINE_TIMEOUT,
  );

  effect(
    "a new run past ciRounds goes to a person, and the item is offered no more",
    () =>
      Effect.gen(function* () {
        const flow = yield* loaded;
        const { fake: before } = yield* parked(flow);
        const fake = seeded(before, Phases.inRound(Phases.PHASES.issue.awaitingCi, 4));
        fake.merge.ci = { state: "red", failedChecks: ["test"] };

        const resumed = yield* onlyResume(fake, flow);
        const finished = yield* runToEnd(flowHandle(repo, "implement", flow), fake, resumed);

        expect(finished.status).toBe("needs-human");
        expect(summaryOf(finished)).toContain("CI is still red after 3 fix attempts");
        expect(fake.requests).toEqual([]);
        expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.needsHuman);
        expect(yield* resumes(fake, flow)).toEqual([]);
      }),
    ENGINE_TIMEOUT,
  );

  effect(
    "leaves an item another persona parked to it, and holds one parked at a node the document lost",
    () =>
      Effect.gen(function* () {
        const flow = yield* loaded;
        const { fake: before } = yield* parked(flow);
        const data = Option.getOrThrow(parkedData(before, ISSUE_ITEM));

        const theirs = seeded(before, "awaiting-ci", {
          ...rawData(before, ISSUE_ITEM),
          resume: { ...data.resume, login: "someone-else" },
        });

        theirs.merge.ci = { state: "green" };
        expect((yield* resumes(theirs, flow)).map((found) => found.elsewhere)).toEqual([
          "parked by someone-else",
        ]);

        const lost = seeded(before, "awaiting-ci", {
          ...rawData(before, ISSUE_ITEM),
          resume: { ...data.resume, node: "waitedOnce" },
        });

        lost.merge.ci = { state: "green" };
        expect((yield* resumes(lost, flow)).map((found) => found.held)).toEqual([
          "parked at waitedOnce, a step implement no longer has",
        ]);
      }),
    ENGINE_TIMEOUT,
  );

  effect(
    "taking the issue's labels off changes nothing",
    () =>
      Effect.gen(function* () {
        const flow = yield* loaded;
        const { fake: before } = yield* parked(flow);
        const fake = seeded(before, "awaiting-ci");
        fake.setLabels(ISSUE, []);
        fake.merge.ci = { state: "green" };

        expect((yield* resumes(fake, flow)).map((found) => found.key)).toEqual([`issue-${ISSUE}`]);
      }),
    ENGINE_TIMEOUT,
  );
});

describe("the address-review document in a CI job", () => {
  const loaded = loadFlow(documentOf(ADDRESS_REVIEW_DOCUMENT));

  const work = item(`pr-${PULL}-changes-1`, {
    pullRequest: PULL,
    headRef: `auto/issue-${ISSUE}`,
    agentWritten: true,
    reviewer: "data-quail",
    reviewedSha: HEAD,
  });

  // A pull request this persona wrote, whose latest review, by data-quail,
  // asks for changes on HEAD, in a CI job.
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
    // The implement run's push.
    fake.git.pushes = 1;

    return fake;
  };

  effect(
    "pushes the fix, parks on its pending CI, and a new run asks the reviewer again without addressing again",
    () =>
      Effect.gen(function* () {
        const flow = yield* loaded;
        const handle = flowHandle(repo, "address-review", flow);
        const fake = changesAsked();
        fake.merge.afterPush = Option.some({ state: "pending", waitingOn: ["test"] });

        const run = yield* runUntil(handle, fake, work, waitsOnCi);
        fake.refs.clear();

        expect(run.status).toBe("running");
        expect(fake.git.pushes).toBe(2);
        expect(fake.phases()[PR_ITEM]).toBe("awaiting-fix-ci");
        expect(Option.map(parkedData(fake, PR_ITEM), (found) => found.resume.node)).toEqual(
          Option.some("ci"),
        );
        // The reviewer isn't asked again until CI has finished.
        expect(fake.people.requested).toEqual([]);

        const held = yield* resumes(fake, flow);
        expect(held.map((found) => found.held)).toEqual([`waits on CI for #${PULL}`]);

        const asked = fake.requests.length;
        fake.merge.ci = { state: "green" };
        fake.merge.afterPush = Option.none();
        const finished = yield* runToEnd(handle, fake, yield* onlyResume(fake, flow));

        expect(finished.status).toBe("done");
        expect(fake.requests).toHaveLength(asked);
        expect(fake.git.pushes).toBe(2);
        expect(fake.people.requested).toEqual(["data-quail"]);
        expect(fake.phases()[PR_ITEM]).toBe("review-asked-again");
        expect(yield* resumes(fake, flow)).toEqual([]);
      }),
    ENGINE_TIMEOUT,
  );
});

describe("the epic document", () => {
  const EPIC = 40;
  const EPIC_ITEM = Claims.epic(EPIC);
  const loaded = loadFlow(documentOf(EPIC_DOCUMENT));
  const fresh = item(`issue-${EPIC}`, { issue: EPIC });

  const madeIssue = (number: number, title: string): LinkedIssue => ({
    number,
    title,
    body: "",
    url: `https://github.com/dataquail/demo/issues/${number}`,
    createdAt: "2026-10-21T00:00:00Z",
    labels: [],
    assignees: [],
    state: "open",
  });

  // The epic in a CI job: #10, then #11 on it; and #12 on its own.
  const epicFake = () => {
    const fake = makeFake("approve", { ciJob: true });
    fake.graph.made.set(EPIC, madeIssue(EPIC, "An epic"));
    fake.setLabels(EPIC, [Plan.LABELS.epic]);

    for (const [number, blockedBy] of [
      [10, []],
      [11, [10]],
      [12, []],
    ] as const) {
      fake.graph.made.set(number, madeIssue(number, `Task ${number}`));
      fake.setLabels(number, [DEFAULT_LABELS.eligible]);
      fake.graph.blockedBy.set(number, [...blockedBy]);
      fake.graph.subIssues.set(EPIC, [...(fake.graph.subIssues.get(EPIC) ?? []), number]);
    }

    return fake;
  };

  const parkedAt = (round: number) => (run: EngineRun) =>
    Effect.map(listRunWaitsHandler({ runId: run.id, signal: Epic.LAYER_CHANGED }), ({ waits }) =>
      waits.some((wait) => wait.deferred === `${Epic.LAYER_CHANGED}:epic-${round}`),
    );

  const offered = (fake: Fake, flow: Flow) =>
    Effect.flatMap(flowTriggered(fake, flow), (items) => Effect.fromOption(Arr.head(items))).pipe(
      Effect.orDie,
    );

  test("starts its rounds from what a parked run kept, or afresh", () => {
    const resumed: WorkItem = item(`issue-${EPIC}`, {
      issue: EPIC,
      resumeEpic: {
        fingerprint: "f",
        tasks: { attempts: [[10, 1]], handedBack: [10], withPerson: [12] },
        layers: { attempts: [[7, 2]], recorded: [], withPerson: [], below: [], caughtUp: [7] },
      },
    });

    const tasks = Blocks.loopStates["epic.tasks"](resumed);
    expect([[...tasks.attempts], [...tasks.handedBack], [...tasks.withPerson]]).toEqual([
      [[10, 1]],
      [10],
      [12],
    ]);

    const upkeep = Blocks.loopStates["stack.upkeep"](resumed);
    expect([[...upkeep.attempts], [...upkeep.caughtUp]]).toEqual([[[7, 2]], [7]]);

    expect(Blocks.loopStates["epic.tasks"](fresh).attempts.size).toBe(0);
  });

  effect(
    "a new run carries on with the attempts the parked one kept, rather than starting afresh",
    () =>
      Effect.gen(function* () {
        const flow = yield* loaded;
        const handle = flowHandle(repo, "epic", flow);
        const fake = epicFake();
        // #12's agent answers with questions the first time.
        fake.author.asks.push("/tmp/demo-worktrees/auto/issue-12");

        yield* runUntil(handle, fake, fresh, parkedAt(1));
        fake.refs.clear();
        expect(fake.phases()[EPIC_ITEM]).toBe("waiting");

        // A person answers, and hands #12 back: the epic is offered again,
        // as work a run may start, with its record's data.
        fake.setLabels(12, [DEFAULT_LABELS.eligible]);
        const again = yield* offered(fake, flow);
        expect(mayStart(again)).toBe(true);

        yield* runUntil(handle, fake, again, parkedAt(1));

        // The new run took #12 up as its second attempt, and started nothing else again.
        const steps = fake.steps.flatMap(Option.toArray);
        expect(steps).toContain("implement#task-12-2");

        for (const once of ["implement#task-10", "implement#task-11", "implement#task-12"]) {
          expect(steps.filter((step) => step === once)).toHaveLength(1);
        }
      }),
    ENGINE_TIMEOUT,
  );
});
