import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import { RunAlreadyFinished, RunNotFound } from "../domain/run/run.errors.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";

// A run naming a work item it touched, such as the pull request an issue's
// run opened: what makes the runs that share a subject one piece of work.
export const NameSubjectCommand = Command.make("NameSubjectCommand", {
  payload: { runId: RunId, subject: Schema.String },
  success: RunView,
  failure: Schema.Union([RunNotFound, RunAlreadyFinished]),
});

export type NameSubjectPayload = Command.Payload<typeof NameSubjectCommand>;
