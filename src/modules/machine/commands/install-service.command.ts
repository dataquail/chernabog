import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { ServiceFailed } from "../domain/machine-setup/machine-setup.errors.ts";

// What the service manager registered, or removed.
export class ServiceUnit extends Schema.Class<ServiceUnit, { readonly brand: "ServiceUnit" }>(
  "ServiceUnit",
)({
  path: Schema.String,
}) {}

// Registers the daemon with this machine's service manager, and starts it.
export const InstallServiceCommand = Command.make("InstallServiceCommand", {
  success: ServiceUnit,
  failure: ServiceFailed,
});
