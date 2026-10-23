import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ServiceFailed } from "../../domain/machine-setup/machine-setup.errors.ts";
import { ServiceManagerClient } from "../../domain/ports/clients/service-manager.client.ts";

const UNIT = "/home/dev/.config/systemd/user/chernabog.service";

// A service manager in memory: whether the daemon's registered, and running.
export const ServiceManagerClientFake = (registered: boolean) =>
  Layer.effect(
    ServiceManagerClient,
    Effect.gen(function* () {
      const state = yield* Ref.make({ registered, running: registered });

      return ServiceManagerClient.of({
        install: Ref.set(state, { registered: true, running: true }).pipe(Effect.as(UNIT)),
        uninstall: Ref.set(state, { registered: false, running: false }).pipe(Effect.as(UNIT)),
        installed: Ref.get(state).pipe(Effect.map((now) => now.registered)),
        start: Effect.gen(function* () {
          if (!(yield* Ref.get(state)).registered) {
            return yield* new ServiceFailed({
              message: "the daemon is not installed; run chernabog install",
            });
          }

          yield* Ref.update(state, (now) => ({ ...now, running: true }));
        }),
        stop: Ref.update(state, (now) => ({ ...now, running: false })),
      });
    }),
  );
