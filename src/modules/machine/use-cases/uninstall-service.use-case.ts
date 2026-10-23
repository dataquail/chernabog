import * as Effect from "effect/Effect";

import { ServiceManagerClient } from "../domain/ports/clients/service-manager.client.ts";
import { ServiceUnit } from "./service.result.ts";

// Stops the daemon and removes it from the service manager.
export const uninstallServiceUseCase = Effect.fn("uninstallServiceUseCase")(function* () {
  return ServiceUnit.make({ path: yield* (yield* ServiceManagerClient).uninstall });
});
