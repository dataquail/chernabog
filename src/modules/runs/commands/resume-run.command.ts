import { Command } from "@effect-server-utils/cqrs";

import { RunId } from "../../../kernel/run-id.id.ts";
import { FoundRun } from "../domain/run/run-view.value-object.ts";

// Resumes a run in flight whose workflow a restart suspended, so it goes on
// from its journal. A run that ended, or never got an execution, is left as is.
export const ResumeRunCommand = Command.make("ResumeRunCommand", {
  payload: { runId: RunId },
  success: FoundRun,
});

export type ResumeRunPayload = Command.Payload<typeof ResumeRunCommand>;
