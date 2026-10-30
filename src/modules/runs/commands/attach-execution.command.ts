import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import { RunAlreadyFinished, RunNotFound } from "../domain/run/run.errors.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";

// The workflow execution the engine started for a run, recorded so it can be
// polled and resumed.
export const AttachExecutionCommand = Command.make("AttachExecutionCommand", {
  payload: { runId: RunId, executionId: Schema.String },
  success: RunView,
  failure: Schema.Union([RunNotFound, RunAlreadyFinished]),
});

export type AttachExecutionPayload = Command.Payload<typeof AttachExecutionCommand>;
