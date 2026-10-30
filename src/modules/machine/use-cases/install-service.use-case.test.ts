import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { ServiceManagerClient } from "../domain/ports/clients/service-manager.client.ts";
import { ServiceManagerClientFake } from "../infrastructure/clients/service-manager.client-fake.ts";
import { installServiceUseCase } from "./install-service.use-case.ts";

describe("installServiceUseCase", () => {
  effect("registers the daemon, saying where", () =>
    Effect.gen(function* () {
      expect((yield* installServiceUseCase()).path).toContain("chernabog.service");
      expect(yield* (yield* ServiceManagerClient).installed).toBe(true);
    }).pipe(Effect.provide(ServiceManagerClientFake(false))),
  );
});
