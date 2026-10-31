import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { ServiceManagerClientFake } from "../infrastructure/clients/service-manager.client-fake.ts";
import { refreshServiceHandler } from "./refresh-service.handler.ts";

describe("refreshServiceHandler", () => {
  effect("says which unit an upgrade rewrote", () =>
    Effect.gen(function* () {
      expect((yield* refreshServiceHandler()).rewrote).toEqual(
        Option.some("/home/dev/.config/systemd/user/chernabog.service"),
      );
    }).pipe(Effect.provide([ServiceManagerClientFake(true, true), PassThroughUnitOfWork])),
  );

  effect("rewrites nothing for a unit that is current, or none installed", () =>
    Effect.gen(function* () {
      expect((yield* refreshServiceHandler()).rewrote).toEqual(Option.none());
    }).pipe(Effect.provide([ServiceManagerClientFake(true), PassThroughUnitOfWork])),
  );
});
