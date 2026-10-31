import * as Effect from "effect/Effect";

import { ServiceManagerClient } from "../domain/ports/clients/service-manager.client.ts";
import { ServiceUnit } from "./install-service.command.ts";

export const installServiceHandler = Effect.fn("installServiceHandler")(function* () {
  return ServiceUnit.make({ path: yield* (yield* ServiceManagerClient).install });
});
