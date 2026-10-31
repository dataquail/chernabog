import { Command } from "@effect-server-utils/cqrs";

import { ServiceFailed } from "../domain/machine-setup/machine-setup.errors.ts";
import { ServiceUnit } from "./install-service.command.ts";

// Stops the daemon and removes it from the service manager.
export const UninstallServiceCommand = Command.make("UninstallServiceCommand", {
  success: ServiceUnit,
  failure: ServiceFailed,
});
