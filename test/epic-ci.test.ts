// An epic parked between rounds (audit W10 and S4, ADR 0021 decisions 3 and
// 4): a daemon's run or a CI job's ends at the park, so the wait lives in the
// epic's waiting record, with the fingerprint of the epic as the run last
// read it and what the run kept between rounds. Epic.queued offers the epic
// again only once a layer changed since, or a day passed, and the new run
// carries on from what the record kept.
//
// A layer's refresh whose CI is pending (audit W7) can't park on its own
// either: the refresh ends there, the layers above it wait, and so does its
// review, and the refresh is recorded on the layer's own pull request
// (awaiting-refresh-ci), not the epic's record, which keeps only the epic's
// own facts. Epic.queued holds the epic, with why, until that CI settles or
// ciTimeout passes, and the run that takes it up takes the refresh up first,
// then puts the pull request's review phase back.

import { printJson } from "@chernabog/core";
import {
  Claims,
  DEFAULT_LABELS,
  Epic,
  type LinkedIssue,
  Phases,
  Plan,
  type PullRequest,
  type WorkItem,
} from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import epic from "../packages/recipes/flows/epic.ts";
import { mayStart } from "../src/modules/runs/domain/run/work-item.value-object.ts";
import { type FlowHandle, flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listActiveRunsHandler } from "../src/modules/runs/queries/list-active-runs.handler.ts";
import { readRunHistoryHandler } from "../src/modules/runs/queries/read-run-history.handler.ts";
import { documentOf, EPIC_DOCUMENT, loadFlow } from "./compose-harness.ts";
import { effect } from "./effect-test.ts";
import {
  type Fake,
  flowTriggered,
  follow,
  item,
  makeFake,
  onEngine,
  onFake,
  repo,
  runToEnd,
  summaryOf,
  triggered,
} from "./sdk-fakes.ts";

const EPIC = 40;
const EPIC_ITEM = Claims.epic(EPIC);
const working = flowHandle(repo, "epic", epic);

// The tests that run the epic through the engine to its park take
// milliseconds alone, but under the whole suite's load the engine's runner can
// miss health checks for seconds, as plan-ci's and epic-stack's do.
const ENGINE_TIMEOUT = 60_000;

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

// An auto task of the epic, blocked by these.
const task = (fake: Fake, number: number, blockedBy: ReadonlyArray<number> = []) => {
  fake.graph.made.set(number, madeIssue(number, `Task ${number}`));
  fake.setLabels(number, [DEFAULT_LABELS.eligible]);
  fake.graph.blockedBy.set(number, [...blockedBy]);
  fake.graph.subIssues.set(EPIC, [...(fake.graph.subIssues.get(EPIC) ?? []), number]);
};

// The epic, in a CI job: #10, then #11 on it; #12 on its own; and #13, which
// needs both #10 and #12.
const epicFake = () => {
  const fake = makeFake("approve", { ciJob: true });
  fake.graph.made.set(EPIC, madeIssue(EPIC, "An epic"));
  fake.setLabels(EPIC, [Plan.LABELS.epic]);
  task(fake, 10);
  task(fake, 11, [10]);
  task(fake, 12);
  task(fake, 13, [10, 12]);

  return fake;
};

const offered = (fake: Fake) => triggered(fake, Epic.queued).pipe(Effect.orDie);

const onlyOffered = (fake: Fake) =>
  Effect.flatMap(offered(fake), (items) => Effect.fromOption(Arr.head(items))).pipe(Effect.orDie);

// What the epic's waiting record keeps, decoded.
const kept = (fake: Fake) =>
  Option.flatMap(Option.fromUndefinedOr(fake.records().get(EPIC_ITEM)), (record) =>
    Option.flatMap(record.data, (data) => Epic.resuming(item("any", { resumeEpic: data }))),
  );

// Pairs by their first number, as a record keeps them in the order the run met them.
const sorted = (pairs: ReadonlyArray<readonly [number, number]>) =>
  pairs.toSorted(([left], [right]) => left - right);

// Follows a run of the epic from `work`, in the test's engine, to its park,
// which ends the run (ADR 23, decision 2) and lets go of its claims, as a
// spoke's does, and checks it parked in round `round`: the last wait it
// recorded is that round's.
const followToPark = (handle: FlowHandle, work: WorkItem, round: number) =>
  Effect.gen(function* () {
    const run = yield* follow(handle, work);
    const { steps } = yield* readRunHistoryHandler({ runId: run.id }).pipe(Effect.orDie);

    const waited = steps
      .map((step) => step.step)
      .filter((step) => step.startsWith("epic-waiting-"));

    expect([run.status, waited.at(-1)]).toEqual(["ended-at-park", `epic-waiting-${round}`]);

    return run;
  });

// followToPark, in an engine of its own.
const parkIn = (handle: FlowHandle, fake: Fake, work: WorkItem, round: number) =>
  onEngine(handle, fake, followToPark(handle, work, round));

const runToPark = (fake: Fake, work: WorkItem, round: number) => parkIn(working, fake, work, round);

const fresh = item(`issue-${EPIC}`, { issue: EPIC });

// The round a fresh run of epicFake parks in: #10 and #12 in the first, #11
// once #10 is done in the second, and nothing left to start in the third, as
// #13 needs #10 and #12 merged.
const LAST_ROUND = 3;

const pushTo = (fake: Fake, number: number) => {
  for (const pull of Option.toArray(
    Option.fromUndefinedOr(fake.branchPulls.get(Claims.branchFor(number))),
  )) {
    fake.branchPulls.set(pull.headRef, { ...pull, headSha: "pushed000" });
  }
};

describe("an epic parked in a CI job", () => {
  effect(
    "records its wait with what the run kept, and is offered again only once a layer changes",
    () =>
      Effect.gen(function* () {
        const fake = epicFake();
        const run = yield* runToPark(fake, fresh, LAST_ROUND);

        expect(run.status).toBe("ended-at-park");
        expect(fake.phases()[EPIC_ITEM]).toBe("waiting");

        const waiting = kept(fake);
        expect(Option.map(waiting, (found) => sorted(found.tasks.attempts))).toEqual(
          Option.some([
            [10, 1],
            [11, 1],
            [12, 1],
          ]),
        );

        // Nothing changed since it parked: nothing to start.
        expect(yield* offered(fake)).toEqual([]);

        // A push to #10's pull request: work a new run may start, from the record.
        pushTo(fake, 10);
        const changed = yield* onlyOffered(fake);

        expect([changed.key, changed.signals, mayStart(changed)]).toEqual([
          `issue-${EPIC}`,
          [Epic.LAYER_CHANGED],
          true,
        ]);
        expect(Epic.resuming(changed)).toEqual(waiting);
      }),
    ENGINE_TIMEOUT,
  );

  effect(
    "a new run carries on with the attempts the parked one kept",
    () =>
      Effect.gen(function* () {
        const fake = epicFake();
        // #12's agent answers with questions the first time.
        fake.author.asks.push("/tmp/demo-worktrees/auto/issue-12");
        yield* runToPark(fake, fresh, LAST_ROUND);

        // Every task attempted read as something other than ready since, #12
        // as a person's: each may start again once ready.
        expect(
          Option.map(kept(fake), (found) => found.tasks.handedBack.toSorted((a, b) => a - b)),
        ).toEqual(Option.some([10, 11, 12]));

        // A person answers, and hands #12 back.
        fake.setLabels(12, [DEFAULT_LABELS.eligible]);
        const resumed = yield* onlyOffered(fake);
        // A new run counts its rounds afresh: #12 in its first, then nothing left to start.
        yield* runToPark(fake, resumed, 2);

        // The new run took #12 up as its second attempt, and started nothing else again.
        const steps = fake.steps.flatMap(Option.toArray);
        expect(steps).toContain("implement#task-12-2");

        for (const once of ["implement#task-10", "implement#task-11", "implement#task-12"]) {
          expect(steps.filter((step) => step === once)).toHaveLength(1);
        }

        expect(Option.map(kept(fake), (found) => sorted(found.tasks.attempts))).toEqual(
          Option.some([
            [10, 1],
            [11, 1],
            [12, 2],
          ]),
        );
        expect(yield* offered(fake)).toEqual([]);
      }),
    ENGINE_TIMEOUT,
  );

  effect(
    "nothing wakes a parked run: the change is offered to a new run, which parks again with its new round's record",
    () =>
      Effect.gen(function* () {
        const fake = epicFake();
        // #12's agent answers with questions the first time.
        fake.author.asks.push("/tmp/demo-worktrees/auto/issue-12");

        const { active, changed, later, parked } = yield* onEngine(
          working,
          fake,
          Effect.gen(function* () {
            const first = yield* followToPark(working, fresh, LAST_ROUND);

            // A person hands #12 back. The run that parked ended there: no run
            // of the epic is left to signal, and the change is work a new run
            // may start, from the epic's record.
            fake.setLabels(12, [DEFAULT_LABELS.eligible]);
            const offer = yield* onlyOffered(fake);

            const running = yield* listActiveRunsHandler({
              repo: Option.none(),
              persona: Option.none(),
              flow: Option.none(),
            }).pipe(Effect.orDie);

            // The new run works on, and parks in a later round.
            return {
              parked: first,
              changed: offer,
              active: running.runs,
              later: yield* followToPark(working, offer, 2),
            };
          }),
        );

        expect(active).toEqual([]);
        expect(mayStart(changed)).toBe(true);
        expect(later.id).not.toBe(parked.id);
        expect(fake.steps.flatMap(Option.toArray)).toContain("implement#task-12-2");

        // The record is the later park's: the epic as the new run last read it,
        // and #12's second attempt.
        const now = yield* onFake(fake, Epic.fingerprint(EPIC)).pipe(Effect.orDie);
        expect(Option.map(kept(fake), (found) => found.fingerprint)).toEqual(Option.some(now));
        expect(Option.map(kept(fake), (found) => sorted(found.tasks.attempts))).toEqual(
          Option.some([
            [10, 1],
            [11, 1],
            [12, 2],
          ]),
        );

        // Nothing changed since its last park: nothing to offer again.
        expect(yield* offered(fake)).toEqual([]);
      }),
    ENGINE_TIMEOUT,
  );

  effect("deleting the epic's status comment changes nothing", () =>
    Effect.gen(function* () {
      const fake = epicFake();
      const fingerprint = yield* onFake(fake, Epic.fingerprint(EPIC)).pipe(Effect.orDie);

      fake.recordPhase(EPIC_ITEM, "waiting", {
        at: yield* DateTime.now,
        data: { fingerprint, tasks: { attempts: [], handedBack: [] } },
      });

      fake.comments.length = 0;
      expect(yield* offered(fake)).toEqual([]);
    }),
  );

  effect("once a day passes with no layer changed, it is offered without a signal", () =>
    Effect.gen(function* () {
      const fake = epicFake();
      const fingerprint = yield* onFake(fake, Epic.fingerprint(EPIC)).pipe(Effect.orDie);

      fake.recordPhase(EPIC_ITEM, "waiting", {
        at: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
        data: { fingerprint, tasks: { attempts: [[10, 1]], handedBack: [] } },
      });

      const due = yield* onlyOffered(fake);
      expect(Option.fromUndefinedOr(due.signals)).toEqual(Option.none());
      expect(mayStart(due)).toBe(true);
      expect(Option.map(Epic.resuming(due), (found) => found.tasks.attempts)).toEqual(
        Option.some([[10, 1]]),
      );
    }),
  );

  effect("a new run ends an epic whose last task closed, and records it finished", () =>
    Effect.gen(function* () {
      const fake = epicFake();

      fake.recordPhase(EPIC_ITEM, "waiting", {
        at: yield* DateTime.now,
        data: { fingerprint: "stale", tasks: { attempts: [], handedBack: [] } },
      });

      for (const number of [10, 11, 12, 13]) {
        fake.graph.made.set(number, { ...madeIssue(number, `Task ${number}`), state: "closed" });
      }

      const finished = yield* runToEnd(working, fake, yield* onlyOffered(fake));

      expect(finished.status).toBe("done");
      expect(summaryOf(finished)).toBe(`#${EPIC}: every task is closed`);
      expect(fake.phases()[EPIC_ITEM]).toBe("finished");
      expect(yield* offered(fake)).toEqual([]);
    }),
  );
});

const PENDING: Fake["merge"]["ci"] = { state: "pending", waitingOn: ["test"] };

// The layers of a stack in review: #10's pull request on main, #11's on
// #10's branch, and #12's on #11's.
const STACK = [10, 11, 12] as const;

const BELOW = new Map([
  [11, 10],
  [12, 11],
]);

const pullOf = (layer: number) => 300 + layer;
const MIDDLE = pullOf(11);
const REVIEWED = "reviewed0000";

const layerPull = (layer: number): PullRequest => ({
  number: pullOf(layer),
  title: `Task ${layer}`,
  body: `Closes #${layer}\nPart of #${EPIC}`,
  url: `https://github.com/dataquail/demo/pull/${pullOf(layer)}`,
  state: "open",
  headRef: Claims.branchFor(layer),
  headSha: `head${layer}`,
  baseRef: Option.match(Option.fromUndefinedOr(BELOW.get(layer)), {
    onNone: () => "main",
    onSome: Claims.branchFor,
  }),
  labels: [],
  author: "chernabog-bot",
  assignees: [],
  requestedReviewers: [],
});

// The epic over the stack, every layer in review, with #10's branch moved
// on since #11 was brought up to it: refreshing #11 merges something in, and
// pushes. CI on the pull requests reads `ci`.
const stackFake = (ci: Fake["merge"]["ci"]) => {
  const fake = makeFake("approve", { reviewers: ["zach", "data-quail"] });
  fake.graph.made.set(EPIC, madeIssue(EPIC, "An epic"));
  fake.setLabels(EPIC, [Plan.LABELS.epic]);

  for (const layer of STACK) {
    task(fake, layer, Option.toArray(Option.fromUndefinedOr(BELOW.get(layer))));
    fake.branchPulls.set(Claims.branchFor(layer), layerPull(layer));
    // Each layer was handed to review, as every pull request a run opens is.
    fake.recordPhase(Claims.pullRequest(pullOf(layer)), Phases.PHASES.pullRequest.reviewAsked);
  }

  fake.git.makes.add(`merge --no-edit origin/${Claims.branchFor(10)}`);
  fake.merge.ci = ci;

  // zach reviewed a commit the refreshed head is more than a merge of the
  // base onto, so a refresh that settles asks them again.
  fake.submitted.push({ author: "zach", state: "CHANGES_REQUESTED", commitSha: REVIEWED });
  fake.git.refuses.add(`rev-parse --verify --quiet ${REVIEWED}^{commit}`);

  return fake;
};

const MIDDLE_ITEM = Claims.pullRequest(MIDDLE);

// The refreshes left on pending CI, as the layers' pull requests' own records
// keep them.
const refreshesLeft = (fake: Fake) =>
  STACK.flatMap((layer) =>
    Option.toArray(
      Option.flatMap(
        Option.filter(
          Option.fromUndefinedOr(fake.records().get(Claims.pullRequest(pullOf(layer)))),
          (record) => record.phase === Phases.PHASES.pullRequest.awaitingRefreshCi,
        ),
        (record) => Option.flatMap(record.data, Schema.decodeUnknownOption(Epic.PendingRefresh)),
      ),
    ),
  );

// Whether #12's layer was refreshed: its refresh fetches its base, #11's branch.
const topRefreshed = (fake: Fake) =>
  fake.git.ran.includes(`fetch --quiet origin ${Claims.branchFor(11)}`);

const forms = [
  ["the recipe", Effect.succeed(epic)],
  ["the document", loadFlow(documentOf(EPIC_DOCUMENT))],
] as const;

for (const [form, loading] of forms) {
  const handle = Effect.map(loading, (flow) => flowHandle(repo, "epic", flow));

  const offeredBy = (fake: Fake) =>
    Effect.gen(function* () {
      return yield* flowTriggered(fake, yield* loading);
    }).pipe(Effect.orDie);

  const onlyOfferedBy = (fake: Fake) =>
    Effect.flatMap(offeredBy(fake), (items) => Effect.fromOption(Arr.head(items))).pipe(
      Effect.orDie,
    );

  const parkAt = (fake: Fake, work: WorkItem, round: number) =>
    Effect.flatMap(handle, (loaded) => parkIn(loaded, fake, work, round));

  // The epic whose run left #11's refresh on pending CI and parked, with CI
  // now `ci`.
  const refreshLeft = (ci: Fake["merge"]["ci"]) =>
    Effect.gen(function* () {
      const fake = stackFake(PENDING);
      yield* parkAt(fake, fresh, 2);
      fake.merge.ci = ci;

      return fake;
    });

  // Takes the parked epic up, as the run its trigger starts, to its next park.
  const takenUp = (fake: Fake) =>
    Effect.gen(function* () {
      const taken = yield* onlyOfferedBy(fake);
      expect(mayStart(taken)).toBe(true);

      return yield* parkAt(fake, taken, 2);
    });

  describe(`the epic's ${form}, on a layer's refresh whose CI is pending`, () => {
    effect(
      "ends the refresh rather than poll, holds the layers above, and records it on the layer's pull request",
      () =>
        Effect.gen(function* () {
          const before = yield* DateTime.now;
          const fake = stackFake(PENDING);
          const run = yield* parkAt(fake, fresh, 2);

          expect(run.status).toBe("ended-at-park");
          expect(fake.phases()[EPIC_ITEM]).toBe("waiting");

          const [left] = refreshesLeft(fake);
          expect(left).toMatchObject({
            layer: 11,
            pullRequest: MIDDLE,
            base: Claims.branchFor(10),
            round: 1,
          });
          expect(
            Option.exists(DateTime.make(left.since), (began) =>
              DateTime.isGreaterThanOrEqualTo(began, before),
            ),
          ).toBe(true);

          // It pushed, and its review waits for CI.
          expect(fake.git.pushes).toBe(1);
          expect(fake.people.requested).toEqual([]);
          // #12, on #11, wasn't refreshed meanwhile.
          expect(topRefreshed(fake)).toBe(false);
          // The epic's own record keeps none of it.
          expect(
            Option.flatMap(Option.fromUndefinedOr(fake.records().get(EPIC_ITEM)), (record) =>
              Option.map(record.data, printJson),
            ).pipe(Option.getOrElse(() => "")),
          ).not.toContain(`"pullRequest"`);
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "is held, with why, while the refresh's CI is still pending",
      () =>
        Effect.gen(function* () {
          const fake = yield* refreshLeft(PENDING);
          const held = yield* onlyOfferedBy(fake);

          expect(mayStart(held)).toBe(false);
          expect(held.held).toBe(`#11: waits on CI for #${MIDDLE}`);
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "once CI went green, is offered, and the run that takes it up settles its review, then carries the layer above",
      () =>
        Effect.gen(function* () {
          const fake = yield* refreshLeft({ state: "green" });
          const pushes = fake.git.pushes;

          expect(topRefreshed(fake)).toBe(false);
          yield* takenUp(fake);

          // zach is asked again, nothing was pushed to #11 again, and #12
          // was brought up after it.
          expect(fake.people.requested).toEqual(["zach"]);
          expect(fake.git.pushes).toBe(pushes);
          expect(topRefreshed(fake)).toBe(true);
          expect(refreshesLeft(fake)).toEqual([]);
          expect(fake.phases()[MIDDLE_ITEM]).toBe(Phases.PHASES.pullRequest.reviewAskedAgain);
          expect(fake.labelsOf(MIDDLE)).not.toContain(DEFAULT_LABELS.needsHuman);
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "once CI went red, is offered, and the run that takes it up fixes it, then settles its review",
      () =>
        Effect.gen(function* () {
          const fake = yield* refreshLeft({ state: "red", failedChecks: ["test"] });
          const pushes = fake.git.pushes;
          fake.merge.afterPush = Option.some({ state: "green" });
          yield* takenUp(fake);

          expect(fake.git.pushes).toBe(pushes + 1);
          expect(fake.requests.at(-1)?.prompt).toContain("CI failed on pull request");
          expect(fake.people.requested).toEqual(["zach"]);
          expect(refreshesLeft(fake)).toEqual([]);
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "still pending past ciTimeout, counted from when the wait began, gives the layer to a person and holds the one above",
      () =>
        Effect.gen(function* () {
          const fake = yield* refreshLeft(PENDING);
          const [left] = refreshesLeft(fake);

          const since = DateTime.formatIso(
            DateTime.subtractDuration(yield* DateTime.now, Duration.hours(3)),
          );

          const data = yield* Schema.encodeEffect(Epic.PendingRefresh)({ ...left, since }).pipe(
            Effect.orDie,
          );

          fake.recordPhase(MIDDLE_ITEM, Phases.PHASES.pullRequest.awaitingRefreshCi, { data });
          yield* takenUp(fake);

          expect(fake.labelsOf(MIDDLE)).toContain(DEFAULT_LABELS.needsHuman);
          expect(
            fake.comments.some((comment) =>
              comment.body.startsWith("Chernabog stopped bringing this layer up to date"),
            ),
          ).toBe(true);
          expect(fake.people.requested).toEqual([]);
          expect(topRefreshed(fake)).toBe(false);
          expect(refreshesLeft(fake)).toEqual([]);
        }),
      ENGINE_TIMEOUT,
    );
  });
}

// More of an epic's tasks and layers left on pending CI than the epic's 4 KB
// record could have held: each wait is on its own item's record, so none is
// dropped, and the epic's record keeps only the epic's own facts.
describe("an epic with more pending task and layer CI than fit in 4 KB", () => {
  const TASKS = Arr.makeBy(30, (index) => 100 + index);
  const LAYERS = Arr.makeBy(30, (index) => 200 + index);
  const SINCE = "2026-11-22T12:00:00.000Z";

  const openPull = (layer: number): PullRequest => ({
    ...layerPull(layer),
    number: 1000 + layer,
    url: `https://github.com/dataquail/demo/pull/${1000 + layer}`,
    baseRef: "main",
  });

  const taskWait = (issue: number, since = SINCE): Epic.PendingCi => ({
    issue,
    pullRequest: 1000 + issue,
    lane: `task-${issue}`,
    branch: Claims.branchFor(issue),
    base: "main",
    round: 1,
    since,
  });

  const refreshWait = (layer: number, since = SINCE): Epic.PendingRefresh => ({
    layer,
    pullRequest: 1000 + layer,
    baseSha: "f".repeat(40),
    base: Claims.branchFor(layer - 1),
    round: 1,
    since,
    kept: "0".repeat(64),
  });

  // The epic parked, with every task and layer waiting on CI by its own
  // record, each wait begun now, so none has run past ciTimeout.
  const crowded = () =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const fake = makeFake("approve", { reviewers: ["zach", "data-quail"] });
      fake.graph.made.set(EPIC, madeIssue(EPIC, "An epic"));
      fake.setLabels(EPIC, [Plan.LABELS.epic]);
      fake.merge.ci = PENDING;

      for (const number of [...TASKS, ...LAYERS]) {
        task(fake, number);
        fake.branchPulls.set(Claims.branchFor(number), openPull(number));
      }

      for (const issue of TASKS) {
        fake.recordPhase(Claims.issue(issue), Phases.PHASES.issue.awaitingTaskCi, {
          data: yield* Schema.encodeEffect(Epic.PendingCi)(taskWait(issue, now)).pipe(Effect.orDie),
        });
      }

      for (const layer of LAYERS) {
        fake.recordPhase(
          Claims.pullRequest(1000 + layer),
          Phases.PHASES.pullRequest.awaitingRefreshCi,
          {
            data: yield* Schema.encodeEffect(Epic.PendingRefresh)(refreshWait(layer, now)).pipe(
              Effect.orDie,
            ),
          },
        );
      }

      const fingerprint = yield* onFake(fake, Epic.fingerprint(EPIC)).pipe(Effect.orDie);

      fake.recordPhase(EPIC_ITEM, "waiting", {
        at: yield* DateTime.now,
        data: Epic.waitingData({
          fingerprint,
          tasks: {
            attempts: TASKS.map((issue) => [issue, 1] as const),
            handedBack: [],
          },
        }),
      });

      return fake;
    });

  test("would take the epic's record past its 4 KB", () => {
    const waits = printJson({
      tasks: TASKS.map((issue) => Schema.encodeSync(Epic.PendingCi)(taskWait(issue))),
      layers: LAYERS.map((layer) => Schema.encodeSync(Epic.PendingRefresh)(refreshWait(layer))),
    });

    expect(new TextEncoder().encode(waits).length).toBeGreaterThan(4096);
  });

  effect("the epic reads every one of them from their own records", () =>
    Effect.gen(function* () {
      const fake = yield* crowded();
      const left = yield* onFake(fake, Epic.leftOf(EPIC)).pipe(Effect.orDie);

      expect(left.tasks.map((one) => one.issue)).toEqual(TASKS);
      expect(left.refreshes.map((one) => one.layer)).toEqual(LAYERS);
      expect(left.tasks[0]).toEqual(taskWait(TASKS[0], left.tasks[0].since));
      expect(left.refreshes[0]).toEqual(refreshWait(LAYERS[0], left.refreshes[0].since));
    }),
  );

  effect("is held, with why, while all their CI is pending, and offered once one settles", () =>
    Effect.gen(function* () {
      const fake = yield* crowded();
      const held = yield* onlyOffered(fake);

      expect(mayStart(held)).toBe(false);
      expect(held.held).toBe(`#${TASKS[0]}: waits on CI for #${1000 + TASKS[0]}`);

      fake.merge.ci = { state: "green" };
      expect(mayStart(yield* onlyOffered(fake))).toBe(true);
    }),
  );

  effect("passes over a wait whose pull request has closed since", () =>
    Effect.gen(function* () {
      const fake = yield* crowded();

      for (const number of [...TASKS, ...LAYERS]) {
        fake.branchPulls.set(Claims.branchFor(number), { ...openPull(number), state: "closed" });
      }

      // The run that parked read the epic with them closed.
      const fingerprint = yield* onFake(fake, Epic.fingerprint(EPIC)).pipe(Effect.orDie);

      fake.recordPhase(EPIC_ITEM, "waiting", {
        at: yield* DateTime.now,
        data: { fingerprint, tasks: { attempts: [], handedBack: [] } },
      });

      fake.merge.ci = { state: "green" };
      expect(yield* offered(fake)).toEqual([]);
    }),
  );

  for (const [form, loading] of forms) {
    effect(
      `the ${form}'s run that leaves them all on CI parks with them on the tasks' records, and takes them all up`,
      () =>
        Effect.gen(function* () {
          const handle = Effect.map(loading, (flow) => flowHandle(repo, "epic", flow));
          const fake = makeFake("approve", { reviewers: ["zach", "data-quail"] });
          fake.graph.made.set(EPIC, madeIssue(EPIC, "An epic"));
          fake.setLabels(EPIC, [Plan.LABELS.epic]);
          fake.merge.ci = PENDING;

          for (const issue of TASKS) {
            task(fake, issue);
          }

          yield* parkIn(yield* handle, fake, fresh, 2);

          expect(fake.phases()[EPIC_ITEM]).toBe("waiting");
          expect(TASKS.map((issue) => fake.phases()[Claims.issue(issue)])).toEqual(
            TASKS.map(() => Phases.PHASES.issue.awaitingTaskCi),
          );

          const left = yield* onFake(fake, Epic.leftOf(EPIC)).pipe(Effect.orDie);
          expect(left.tasks.map((one) => one.issue).toSorted((a, b) => a - b)).toEqual(TASKS);

          // CI settles on every one: the next run hands each off.
          fake.merge.ci = { state: "green" };
          const taken = Option.getOrThrow(Arr.head(yield* flowTriggered(fake, yield* loading)));
          yield* parkIn(yield* handle, fake, taken, 2);

          expect(TASKS.map((issue) => fake.phases()[Claims.issue(issue)])).toEqual(
            TASKS.map(() => Phases.PHASES.issue.handedOff),
          );
          expect(
            fake.comments.filter((comment) => comment.body.includes("CI passed after the job")),
          ).toHaveLength(TASKS.length);
        }).pipe(Effect.orDie),
      ENGINE_TIMEOUT,
    );
  }
});

const decodeWaiting = Schema.decodeUnknownOption(Epic.Waiting);

describe("the epic's waiting record", () => {
  const attempts = Arr.makeBy(600, (index): readonly [number, number] => [1000 + index, 3]);

  // Nothing is dropped to fit: what the run kept is all written, or the
  // record's 4 KB check fails the write, never a smaller record unseen.
  test("keeps all the run kept, a large epic's layers and tasks too", () => {
    const waiting: Epic.Waiting = {
      fingerprint: "f",
      tasks: { attempts: [[10, 1]], handedBack: [] },
      layers: { attempts: Arr.take(attempts, 40), recorded: [], below: [], caughtUp: [] },
    };

    expect(decodeWaiting(Epic.waitingData(waiting))).toEqual(Option.some(waiting));
  });

  test("past a record's 4 KB, encodes all of it, for the record's own check to refuse", () => {
    const waiting: Epic.Waiting = {
      fingerprint: "f",
      tasks: { attempts, handedBack: [] },
      layers: { attempts, recorded: [], below: [], caughtUp: [] },
    };

    const data = Epic.waitingData(waiting);
    expect(decodeWaiting(data)).toEqual(Option.some(waiting));
    expect(Phases.fitsAPark(data)).toBe(false);
  });
});
