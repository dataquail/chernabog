import * as Effect from "effect/Effect";

import { ServiceManagerClient } from "../domain/ports/clients/service-manager.client.ts";
import { ServiceState } from "./service.result.ts";

// Whether the daemon is installed as a service.
export const checkServiceUseCase = Effect.fn("checkServiceUseCase")(function* () {
  const installed = yield* (yield* ServiceManagerClient).installed;

  return ServiceState.make({ installed });
});
