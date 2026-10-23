import * as Effect from "effect/Effect";

import { ServiceManagerClient } from "../domain/ports/clients/service-manager.client.ts";
import { ServiceState } from "./service.result.ts";

// Stops the daemon until the next start or login; runs in flight resume when
// it comes back.
export const stopServiceUseCase = Effect.fn("stopServiceUseCase")(function* () {
  const manager = yield* ServiceManagerClient;
  yield* manager.stop;

  return ServiceState.make({ installed: yield* manager.installed });
});
