import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RunLogLines } from "../../../kernel/run-log-line.value-object.ts";
import { NodeRefs } from "../domain/plan/node-ref.value-object.ts";
import { RunPlanSpecifications } from "../domain/plan/run-plan.specification.ts";
import { RunPlansRepository } from "../domain/plan/run-plans.repository.ts";
import { RunLogsClient } from "../domain/ports/clients/run-logs.client.ts";
import {
  RunBranch,
  RunEnd,
  RunHistory,
  RunLane,
  RunNodeVisit,
  RunStep,
} from "../domain/run/run-history.value-object.ts";
import { RunLaneSpecifications } from "../domain/run/run-lane.specification.ts";
import { RunLanesRepository } from "../domain/run/run-lanes.repository.ts";
import { type RunNodeEntity } from "../domain/run/run-node.entity.ts";
import { RunNodeSpecifications } from "../domain/run/run-node.specification.ts";
import { RunNodesRepository } from "../domain/run/run-nodes.repository.ts";
import { type RunStepEntity } from "../domain/run/run-step.entity.ts";
import { RunStepSpecifications } from "../domain/run/run-step.specification.ts";
import { RunStepsRepository } from "../domain/run/run-steps.repository.ts";
import { StepOutcome } from "../domain/run/step-outcome.value-object.ts";
import { RunWaitSpecifications } from "../domain/run-wait/run-wait.specification.ts";
import { RunWait } from "../domain/run-wait/run-wait-view.value-object.ts";
import { RunWaitsRepository } from "../domain/run-wait/run-waits.repository.ts";
import { type ReadRunHistoryPayload } from "./read-run-history.query.ts";

// A step as the history shows it: its node only when it has one, and its end
// only once it has one.
const stepOf = (step: RunStepEntity) =>
  RunStep.make({
    step: step.step,
    ...Option.match(step.node, { onNone: () => ({}), onSome: (node) => ({ node }) }),
    enteredAt: step.enteredAt,
    ...Option.match(Option.all({ finishedAt: step.finishedAt, outcome: step.outcome }), {
      onNone: () => ({}),
      onSome: (ended) => ended,
    }),
  });

const isStepOutcome = Schema.is(StepOutcome);

const nodeOf = (mark: RunNodeEntity) =>
  NodeRefs.of({ id: mark.node, round: mark.round, lane: mark.lane });

// A node the run entered, as the history shows it: how it left it only once it has.
const visitOf = (mark: RunNodeEntity) =>
  RunNodeVisit.make({
    node: nodeOf(mark),
    enteredAt: mark.at,
    ...Option.match(
      Option.all({
        finishedAt: mark.finishedAt,
        outcome: Option.filter(mark.outcome, isStepOutcome),
      }),
      { onNone: () => ({}), onSome: (ended) => ended },
    ),
  });

const branchOf = (mark: RunNodeEntity) =>
  Option.map(mark.outcome, (outcome) =>
    RunBranch.make({ node: nodeOf(mark), outcome, takenAt: mark.at }),
  );

const marked = (marks: ReadonlyArray<RunNodeEntity>, mark: RunNodeEntity["mark"]) =>
  marks.filter((each) => each.mark === mark);

export const readRunHistoryHandler = Effect.fn("readRunHistoryHandler")(function* ({
  runId,
}: ReadRunHistoryPayload) {
  const steps = yield* (yield* RunStepsRepository).findMany(RunStepSpecifications.forRun(runId));
  const waits = yield* (yield* RunWaitsRepository).findMany(RunWaitSpecifications.forRun(runId));
  const lanes = yield* (yield* RunLanesRepository).findMany(RunLaneSpecifications.forRun(runId));
  const log = yield* (yield* RunLogsClient).readFrom(runId, 0);
  const marks = yield* (yield* RunNodesRepository).findMany(RunNodeSpecifications.forRun(runId));
  const plan = yield* (yield* RunPlansRepository).findOne(RunPlanSpecifications.forRun(runId));

  return RunHistory.make({
    steps: steps.map(stepOf),
    waits: waits.map((wait) => RunWait.make({ ...wait })),
    lanes: lanes.map((lane) => RunLane.make({ lane: lane.lane, needs: lane.needs })),
    stepLogs: RunLogLines.stepLogsOf(log, lanes.length > 0),
    ...Option.match(plan, { onNone: () => ({}), onSome: (started) => ({ plan: started.hash }) }),
    // A run that left no marks, as one of a flow with no plan, has none to show.
    ...Option.match(
      Option.liftPredicate(marks, (left) => left.length > 0),
      {
        onNone: () => ({}),
        onSome: (left) => ({
          nodes: marked(left, "node").map(visitOf),
          branches: marked(left, "branch").flatMap((mark) => Option.toArray(branchOf(mark))),
          ends: marked(left, "end").map((mark) =>
            RunEnd.make({ node: nodeOf(mark), reachedAt: mark.at }),
          ),
        }),
      },
    ),
  });
});
