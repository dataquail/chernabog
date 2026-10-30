import * as Effect from "effect/Effect";

import { ServiceState } from "../domain/machine-setup/service-state.value-object.ts";
import { ServiceManagerClient } from "../domain/ports/clients/service-manager.client.ts";

export const checkServiceHandler = Effect.fn("checkServiceHandler")(function* () {
  const installed = yield* (yield* ServiceManagerClient).installed;

  return ServiceState.make({ installed });
});
