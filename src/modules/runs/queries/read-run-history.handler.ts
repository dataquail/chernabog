import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunLogLines } from "../../../kernel/run-log-line.value-object.ts";
import { RunLogsClient } from "../domain/ports/clients/run-logs.client.ts";
import { RunHistory, RunLane, RunStep } from "../domain/run/run-history.value-object.ts";
import { RunLaneSpecifications } from "../domain/run/run-lane.specification.ts";
import { RunLanesRepository } from "../domain/run/run-lanes.repository.ts";
import { type RunStepEntity } from "../domain/run/run-step.entity.ts";
import { RunStepSpecifications } from "../domain/run/run-step.specification.ts";
import { RunStepsRepository } from "../domain/run/run-steps.repository.ts";
import { RunWaitSpecifications } from "../domain/run-wait/run-wait.specification.ts";
import { RunWait } from "../domain/run-wait/run-wait-view.value-object.ts";
import { RunWaitsRepository } from "../domain/run-wait/run-waits.repository.ts";
import { type ReadRunHistoryPayload } from "./read-run-history.query.ts";

// A step as the history shows it: its end only once it has one.
const stepOf = (step: RunStepEntity) =>
  RunStep.make({
    step: step.step,
    enteredAt: step.enteredAt,
    ...Option.match(Option.all({ finishedAt: step.finishedAt, outcome: step.outcome }), {
      onNone: () => ({}),
      onSome: (ended) => ended,
    }),
  });

export const readRunHistoryHandler = Effect.fn("readRunHistoryHandler")(function* ({
  runId,
}: ReadRunHistoryPayload) {
  const steps = yield* (yield* RunStepsRepository).findMany(RunStepSpecifications.forRun(runId));
  const waits = yield* (yield* RunWaitsRepository).findMany(RunWaitSpecifications.forRun(runId));
  const lanes = yield* (yield* RunLanesRepository).findMany(RunLaneSpecifications.forRun(runId));
  const log = yield* (yield* RunLogsClient).readFrom(runId, 0);

  return RunHistory.make({
    steps: steps.map(stepOf),
    waits: waits.map((wait) => RunWait.make({ ...wait })),
    lanes: lanes.map((lane) => RunLane.make({ lane: lane.lane, needs: lane.needs })),
    stepLogs: RunLogLines.stepLogsOf(log, lanes.length > 0),
  });
});
