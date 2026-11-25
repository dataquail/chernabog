import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { FlowFailed, RunAlreadyActive, RunAlreadyFinished } from "../domain/run/run.errors.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";
import { WorkItem } from "../domain/run/work-item.value-object.ts";

// Executes a run another process recorded (ADR 23, decision 2): the hub
// records the run and attaches its execution, which is keyed by the run, and
// hands it to its spoke, which executes its workflow, in a journal of the
// run's own, for the item the hub handed it. The run is as the hub handed it
// over (SpokeHandOver): a spoke never opens state.db (decision 3). A run that
// ended, one with no execution, one that already has a journal (another
// spoke's) and one whose flow this process didn't load are refused.
export const ExecuteRunCommand = Command.make("ExecuteRunCommand", {
  payload: { run: RunView, item: WorkItem },
  success: RunView,
  failure: Schema.Union([RunAlreadyFinished, RunAlreadyActive, FlowFailed]),
});

export type ExecuteRunPayload = Command.Payload<typeof ExecuteRunCommand>;
