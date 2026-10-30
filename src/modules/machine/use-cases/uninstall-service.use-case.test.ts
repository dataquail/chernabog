import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { ServiceManagerClient } from "../domain/ports/clients/service-manager.client.ts";
import { ServiceManagerClientFake } from "../infrastructure/clients/service-manager.client-fake.ts";
import { uninstallServiceUseCase } from "./uninstall-service.use-case.ts";

describe("uninstallServiceUseCase", () => {
  effect("removes the daemon's service", () =>
    Effect.gen(function* () {
      yield* uninstallServiceUseCase();

      expect(yield* (yield* ServiceManagerClient).installed).toBe(false);
    }).pipe(Effect.provide(ServiceManagerClientFake(true))),
  );
});
