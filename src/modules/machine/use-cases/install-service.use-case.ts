import * as Effect from "effect/Effect";

import { ServiceManagerClient } from "../domain/ports/clients/service-manager.client.ts";
import { ServiceUnit } from "./service.result.ts";

// Registers the daemon with this machine's service manager, and starts it.
export const installServiceUseCase = Effect.fn("installServiceUseCase")(function* () {
  return ServiceUnit.make({ path: yield* (yield* ServiceManagerClient).install });
});
