import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { ServiceManagerClientFake } from "../infrastructure/clients/service-manager.client-fake.ts";
import { checkServiceHandler } from "./check-service.handler.ts";

describe("checkServiceHandler", () => {
  effect("says whether the daemon is installed", () =>
    Effect.gen(function* () {
      expect((yield* checkServiceHandler()).installed).toBe(false);
    }).pipe(Effect.provide(ServiceManagerClientFake(false))),
  );
});
