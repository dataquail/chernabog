// An epic's task whose CI is pending (audit W7, ADR 0021 decision 4). Its
// lane can't park on its own, so it leaves the round rather than poll,
// recording the wait on the task's own record (awaiting-task-ci), and the
// epic parks. Epic.queued
// holds the epic, with why, while that CI is pending with time left, and
// offers it once CI is green or red, or ciTimeout passes from when the wait
// began. The run that takes the epic up takes the task up (Epic.takeUpCi,
// epic.settleCi): it hands the pull request off on green, fixes red, and
// gives the task to a person past ciTimeout, as the lane would have. The
// recipe and its document leave and take up alike.

import { printJson } from "@chernabog/core";
import {
  Claims,
  DEFAULT_LABELS,
  Epic,
  type LinkedIssue,
  Phases,
  Plan,
  type WorkItem,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import epic from "../packages/recipes/flows/epic.ts";
import { mayStart } from "../src/modules/runs/domain/run/work-item.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import { documentOf, EPIC_DOCUMENT, loadFlow } from "./compose-harness.ts";
import { effect } from "./effect-test.ts";
import {
  type EngineRun,
  type Fake,
  flowTriggered,
  item,
  makeFake,
  repo,
  runUntil,
} from "./sdk-fakes.ts";

// The engine runs below take milliseconds alone, but under the whole suite's
// load the engine's runner can miss health checks for seconds.
const ENGINE_TIMEOUT = 60_000;

const EPIC = 40;
const TASK = 10;
const EPIC_ITEM = Claims.epic(EPIC);

const forms = [
  ["the recipe", Effect.succeed(epic)],
  ["the document", loadFlow(documentOf(EPIC_DOCUMENT))],
] as const;

const PENDING: Fake["merge"]["ci"] = { state: "pending", waitingOn: ["test"] };

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

// The epic, with one auto task, #10.
const epicFake = () => {
  const fake = makeFake("approve", { reviewers: ["zach", "data-quail"] });
  fake.graph.made.set(EPIC, madeIssue(EPIC, "An epic"));
  fake.setLabels(EPIC, [Plan.LABELS.epic]);
  fake.graph.made.set(TASK, madeIssue(TASK, `Task ${TASK}`));
  fake.setLabels(TASK, [DEFAULT_LABELS.eligible]);
  fake.graph.blockedBy.set(TASK, []);
  fake.graph.subIssues.set(EPIC, [TASK]);

  return fake;
};

const TASK_ITEM = Claims.issue(TASK);

// The task's wait on its pending CI, as its own record keeps it; none once
// the record is anything else.
const pendingCi = (fake: Fake) =>
  Option.toArray(
    Option.flatMap(
      Option.filter(
        Option.fromUndefinedOr(fake.records().get(TASK_ITEM)),
        (record) => record.phase === Phases.PHASES.issue.awaitingTaskCi,
      ),
      (record) => Option.flatMap(record.data, Schema.decodeUnknownOption(Epic.PendingCi)),
    ),
  );

// Whether the run is parked on the epic's round `round`.
const parkedAt = (round: number) => (run: EngineRun) =>
  Effect.map(listRunWaitsHandler({ runId: run.id, signal: Epic.LAYER_CHANGED }), ({ waits }) =>
    waits.some((wait) => wait.deferred === `${Epic.LAYER_CHANGED}:epic-${round}`),
  );

const fresh = item(`issue-${EPIC}`, { issue: EPIC });

for (const [form, loading] of forms) {
  const handle = Effect.map(loading, (flow) => flowHandle(repo, "epic", flow));

  const offered = (fake: Fake) =>
    Effect.gen(function* () {
      return yield* flowTriggered(fake, yield* loading);
    }).pipe(Effect.orDie);

  const onlyOffered = (fake: Fake) =>
    Effect.flatMap(offered(fake), (items) => Effect.fromOption(Arr.head(items))).pipe(Effect.orDie);

  // Runs the epic from `work` until it parks at `round`, then lets go of
  // every claim, as a run ending at its park does.
  const runToPark = (fake: Fake, work: WorkItem, round: number) =>
    Effect.gen(function* () {
      const run = yield* runUntil(yield* handle, fake, work, parkedAt(round));
      fake.refs.clear();

      return run;
    });

  // An epic whose run left #10 on its pending CI and parked, with CI now `ci`.
  const leftOnCi = (ci: Fake["merge"]["ci"]) =>
    Effect.gen(function* () {
      const fake = epicFake();
      fake.merge.ci = PENDING;
      yield* runToPark(fake, fresh, 2);
      fake.merge.ci = ci;

      return fake;
    });

  // Takes the parked epic up, as the run its trigger starts, to its next park.
  const takenUp = (fake: Fake) =>
    Effect.gen(function* () {
      const taken = yield* onlyOffered(fake);
      expect(mayStart(taken)).toBe(true);

      return yield* runToPark(fake, taken, 2);
    });

  describe(`the epic's ${form}, on a task whose CI is pending`, () => {
    effect(
      "leaves the task's lane rather than poll, records its pending CI on the task, and parks",
      () =>
        Effect.gen(function* () {
          const before = yield* DateTime.now;
          const fake = epicFake();
          fake.merge.ci = PENDING;
          const run = yield* runToPark(fake, fresh, 2);

          expect(run.status).toBe("ended-at-park");
          expect(fake.phases()[EPIC_ITEM]).toBe("waiting");
          expect(fake.phases()[TASK_ITEM]).toBe(Phases.PHASES.issue.awaitingTaskCi);

          const [left] = pendingCi(fake);
          expect(left).toMatchObject({
            issue: TASK,
            lane: `task-${TASK}`,
            branch: Claims.branchFor(TASK),
            round: 1,
          });
          expect(
            Option.exists(DateTime.make(left.since), (began) =>
              DateTime.isGreaterThanOrEqualTo(began, before),
            ),
          ).toBe(true);
          // Not handed off: nobody is asked to review while CI runs.
          expect(fake.people.requested).toEqual([]);
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
      "is held, with why, while the task's CI is still pending",
      () =>
        Effect.gen(function* () {
          const fake = yield* leftOnCi(PENDING);
          const [left] = pendingCi(fake);
          const held = yield* onlyOffered(fake);

          expect(mayStart(held)).toBe(false);
          expect(held.held).toBe(`#${TASK}: waits on CI for #${left.pullRequest}`);
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "once CI went green, is offered, and the run that takes it up hands the task off",
      () =>
        Effect.gen(function* () {
          const fake = yield* leftOnCi({ state: "green" });
          const agentRuns = fake.requests.length;
          yield* takenUp(fake);

          expect(fake.people.requested).toHaveLength(1);
          expect(
            fake.comments.some((comment) => comment.body.includes("CI passed after the job")),
          ).toBe(true);
          // No agent ran again, and nothing is left on CI.
          expect(fake.requests).toHaveLength(agentRuns);
          expect(pendingCi(fake)).toEqual([]);
          expect(fake.phases()[TASK_ITEM]).toBe(Phases.PHASES.issue.handedOff);
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "once CI went red, is offered, and the run that takes it up fixes it, then hands it off",
      () =>
        Effect.gen(function* () {
          const fake = yield* leftOnCi({ state: "red", failedChecks: ["test"] });
          const pushes = fake.git.pushes;
          fake.merge.afterPush = Option.some({ state: "green" });
          yield* takenUp(fake);

          expect(fake.git.pushes).toBe(pushes + 1);
          expect(fake.requests.at(-1)?.prompt).toContain("CI failed on pull request");
          expect(fake.people.requested).toHaveLength(1);
          expect(pendingCi(fake)).toEqual([]);
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "still pending past ciTimeout, counted from when the wait began, gives the task to a person",
      () =>
        Effect.gen(function* () {
          const fake = yield* leftOnCi(PENDING);
          const [left] = pendingCi(fake);

          const since = DateTime.formatIso(
            DateTime.subtractDuration(yield* DateTime.now, Duration.hours(3)),
          );

          const data = yield* Schema.encodeEffect(Epic.PendingCi)({ ...left, since }).pipe(
            Effect.orDie,
          );

          fake.recordPhase(TASK_ITEM, Phases.PHASES.issue.awaitingTaskCi, { data });

          yield* takenUp(fake);

          expect(fake.labelsOf(TASK)).toContain(DEFAULT_LABELS.needsHuman);
          expect(fake.people.requested).toEqual([]);
          expect(pendingCi(fake)).toEqual([]);
        }),
      ENGINE_TIMEOUT,
    );
  });
}
