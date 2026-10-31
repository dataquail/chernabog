import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../test/effect-test.ts";
import { unserializable } from "../../../test/serializable.ts";
import { machineCommandGroup } from "./machine.command-handlers.ts";
import { machineQueryGroup } from "./machine.query-handlers.ts";

// The daemon's protocol and the dashboard carry the machine module's messages
// over JSON, so each must survive a round trip through it (ADR 13).
describe("the machine module's messages", () => {
  effect("all cross JSON", () =>
    Effect.gen(function* () {
      expect(yield* unserializable([machineCommandGroup, machineQueryGroup])).toEqual([]);
    }),
  );
});
