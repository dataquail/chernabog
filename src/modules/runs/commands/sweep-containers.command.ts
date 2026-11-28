import { Command } from "@effect-server-utils/cqrs";

import { SweptContainers } from "../domain/run/run-view.value-object.ts";

// Removes the containers labelled with a run that has ended (ADR 24,
// decision 9), which a shim or a VM that died left behind: cancel removes a
// run's own as it ends it, and a session's `__launch` its own as it exits, so
// one still left is one neither got to. A container whose session's
// `__launch` still runs is left to it, as a session a person works in is.
export const SweepContainersCommand = Command.make("SweepContainersCommand", {
  success: SweptContainers,
});
