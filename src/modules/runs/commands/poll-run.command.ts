import { Command } from "@effect-server-utils/cqrs";

import { RunId } from "../../../kernel/run-id.id.ts";
import { FoundRun } from "../domain/run/run-view.value-object.ts";

// Records a run as ended once its workflow completes, and is the run as it is
// now: still running, ended now, or as another poll recorded its ending.
export const PollRunCommand = Command.make("PollRunCommand", {
  payload: { runId: RunId },
  success: FoundRun,
});

export type PollRunPayload = Command.Payload<typeof PollRunCommand>;
