import { Command } from "@effect-server-utils/cqrs";

import { ServiceFailed } from "../domain/machine-setup/machine-setup.errors.ts";
import { ServiceState } from "../domain/machine-setup/service-state.value-object.ts";

// Stops the daemon until the next start or login; runs in flight resume when
// it comes back.
export const StopServiceCommand = Command.make("StopServiceCommand", {
  success: ServiceState,
  failure: ServiceFailed,
});
