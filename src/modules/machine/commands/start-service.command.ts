import { Command } from "@effect-server-utils/cqrs";

import { ServiceFailed } from "../domain/machine-setup/machine-setup.errors.ts";
import { ServiceState } from "../domain/machine-setup/service-state.value-object.ts";

// Starts the installed daemon. Fails when it isn't installed.
export const StartServiceCommand = Command.make("StartServiceCommand", {
  success: ServiceState,
  failure: ServiceFailed,
});
