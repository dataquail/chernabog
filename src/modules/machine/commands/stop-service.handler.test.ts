import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { ServiceManagerClientFake } from "../infrastructure/clients/service-manager.client-fake.ts";
import { stopServiceHandler } from "./stop-service.handler.ts";

describe("stopServiceHandler", () => {
  effect("stops the daemon, leaving it installed", () =>
    Effect.gen(function* () {
      expect((yield* stopServiceHandler()).installed).toBe(true);
    }).pipe(Effect.provide(ServiceManagerClientFake(true))),
  );
});
