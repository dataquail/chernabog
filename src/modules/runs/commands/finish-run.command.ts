import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import { RunAlreadyFinished, RunNotFound } from "../domain/run/run.errors.ts";
import { RunEnding } from "../domain/run/run-status.value-object.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";

// Records a run as ended, once its workflow completes, with how it ended. A
// run ends once: a second ending fails, leaving the first.
export const FinishRunCommand = Command.make("FinishRunCommand", {
  payload: { runId: RunId, status: RunEnding, summary: Schema.String },
  success: RunView,
  failure: Schema.Union([RunNotFound, RunAlreadyFinished]),
});

export type FinishRunPayload = Command.Payload<typeof FinishRunCommand>;
