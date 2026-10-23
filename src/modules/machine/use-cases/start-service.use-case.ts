import * as Effect from "effect/Effect";

import { ServiceManagerClient } from "../domain/ports/clients/service-manager.client.ts";
import { ServiceState } from "./service.result.ts";

// Starts the installed daemon. Fails when it isn't installed.
export const startServiceUseCase = Effect.fn("startServiceUseCase")(function* () {
  yield* (yield* ServiceManagerClient).start;

  return ServiceState.make({ installed: true });
});
