import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { ServiceManagerClientFake } from "../infrastructure/clients/service-manager.client-fake.ts";
import { startServiceHandler } from "./start-service.handler.ts";

describe("startServiceHandler", () => {
  effect("starts an installed daemon", () =>
    Effect.gen(function* () {
      expect((yield* startServiceHandler()).installed).toBe(true);
    }).pipe(Effect.provide([ServiceManagerClientFake(true), PassThroughUnitOfWork])),
  );

  effect("refuses a daemon not installed", () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(startServiceHandler())).message).toBe(
        "the daemon is not installed; run chernabog install",
      );
    }).pipe(Effect.provide([ServiceManagerClientFake(false), PassThroughUnitOfWork])),
  );
});
