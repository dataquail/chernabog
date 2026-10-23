import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { ServiceManagerClientFake } from "../infrastructure/clients/service-manager.client-fake.ts";
import { startServiceUseCase } from "./start-service.use-case.ts";

describe("startServiceUseCase", () => {
  effect("starts an installed daemon", () =>
    Effect.gen(function* () {
      expect((yield* startServiceUseCase()).installed).toBe(true);
    }).pipe(Effect.provide(ServiceManagerClientFake(true))),
  );

  effect("refuses a daemon not installed", () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(startServiceUseCase())).message).toBe(
        "the daemon is not installed; run chernabog install",
      );
    }).pipe(Effect.provide(ServiceManagerClientFake(false))),
  );
});
