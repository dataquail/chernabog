import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";

import { ServiceManagerClient } from "../domain/ports/clients/service-manager.client.ts";
import { RefreshedService } from "./refresh-service.command.ts";

export const refreshServiceHandler = Effect.fn("refreshServiceHandler")(
  function* () {
    return RefreshedService.make({ rewrote: yield* (yield* ServiceManagerClient).refresh });
  },
  withUnitOfWork,
  // Its stores are files on this machine: they have no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
