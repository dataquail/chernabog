import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import { NodeRef } from "../domain/plan/node-ref.value-object.ts";
import { RunAlreadyFinished, RunNotFound } from "../domain/run/run.errors.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";

// A run entering a step, as its log reports it: its current step, and one
// more on the path it has taken, at the node of its plan it ran in, if any.
// A run that has ended takes no step.
export const EnterStepCommand = Command.make("EnterStepCommand", {
  payload: { runId: RunId, step: Schema.String, node: Schema.optionalKey(NodeRef) },
  success: RunView,
  failure: Schema.Union([RunNotFound, RunAlreadyFinished]),
});

export type EnterStepPayload = Command.Payload<typeof EnterStepCommand>;
