import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";

import { ServiceManagerClient } from "../domain/ports/clients/service-manager.client.ts";
import { ServiceUnit } from "./install-service.command.ts";

export const uninstallServiceHandler = Effect.fn("uninstallServiceHandler")(
  function* () {
    return ServiceUnit.make({ path: yield* (yield* ServiceManagerClient).uninstall });
  },
  withUnitOfWork,
  // Its stores are files on this machine: they have no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
