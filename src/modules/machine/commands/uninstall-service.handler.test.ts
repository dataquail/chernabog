import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { ServiceManagerClient } from "../domain/ports/clients/service-manager.client.ts";
import { ServiceManagerClientFake } from "../infrastructure/clients/service-manager.client-fake.ts";
import { uninstallServiceHandler } from "./uninstall-service.handler.ts";

describe("uninstallServiceHandler", () => {
  effect("removes the daemon's service", () =>
    Effect.gen(function* () {
      yield* uninstallServiceHandler();

      expect(yield* (yield* ServiceManagerClient).installed).toBe(false);
    }).pipe(Effect.provide([ServiceManagerClientFake(true), PassThroughUnitOfWork])),
  );
});
