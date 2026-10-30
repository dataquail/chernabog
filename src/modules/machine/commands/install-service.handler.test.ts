import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { ServiceManagerClient } from "../domain/ports/clients/service-manager.client.ts";
import { ServiceManagerClientFake } from "../infrastructure/clients/service-manager.client-fake.ts";
import { installServiceHandler } from "./install-service.handler.ts";

describe("installServiceHandler", () => {
  effect("registers the daemon, saying where", () =>
    Effect.gen(function* () {
      expect((yield* installServiceHandler()).path).toContain("chernabog.service");
      expect(yield* (yield* ServiceManagerClient).installed).toBe(true);
    }).pipe(Effect.provide(ServiceManagerClientFake(false))),
  );
});
