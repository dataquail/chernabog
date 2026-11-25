import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import {
  FlowFailed,
  RunAlreadyActive,
  RunAlreadyFinished,
  RunNotFound,
} from "../domain/run/run.errors.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";
import { WorkItem } from "../domain/run/work-item.value-object.ts";

// Executes a run another process recorded (ADR 23, decision 2): the hub
// records the run, and its spoke executes its workflow, in a journal of the
// run's own, for the item the hub handed it, and attaches the execution. A
// run that ended, or already has an execution (another spoke's), is refused,
// as is one whose flow this process didn't load.
//
// Interim, until #659: the spoke attaches the execution in state.db itself.
// Once the hub attaches it (an execution is keyed by its run), this keeps
// only the execute.
export const ExecuteRunCommand = Command.make("ExecuteRunCommand", {
  payload: { runId: RunId, item: WorkItem },
  success: RunView,
  failure: Schema.Union([RunNotFound, RunAlreadyFinished, RunAlreadyActive, FlowFailed]),
});

export type ExecuteRunPayload = Command.Payload<typeof ExecuteRunCommand>;
