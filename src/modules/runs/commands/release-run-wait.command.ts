import { Command } from "@effect-server-utils/cqrs";

import { RunWait } from "../domain/run-wait/run-wait-view.value-object.ts";

// Forgets a wait once its signal has woken the run.
export const ReleaseRunWaitCommand = Command.make("ReleaseRunWaitCommand", {
  payload: { wait: RunWait },
  success: RunWait,
});

export type ReleaseRunWaitPayload = Command.Payload<typeof ReleaseRunWaitCommand>;
