import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";

import { ServiceState } from "../domain/machine-setup/service-state.value-object.ts";
import { ServiceManagerClient } from "../domain/ports/clients/service-manager.client.ts";

export const startServiceHandler = Effect.fn("startServiceHandler")(
  function* () {
    yield* (yield* ServiceManagerClient).start;

    return ServiceState.make({ installed: true });
  },
  withUnitOfWork,
  // Its stores are files on this machine: they have no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
