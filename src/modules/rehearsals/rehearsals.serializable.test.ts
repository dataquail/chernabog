import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../test/effect-test.ts";
import { unserializable } from "../../../test/serializable.ts";
import { rehearsalsCommandGroup } from "./rehearsals.command-handlers.ts";
import { rehearsalsQueryGroup } from "./rehearsals.query-handlers.ts";

// The daemon's protocol and the dashboard carry the rehearsals module's messages
// over JSON, so each must survive a round trip through it (ADR 13).
describe("the rehearsals module's messages", () => {
  effect("all cross JSON", () =>
    Effect.gen(function* () {
      expect(yield* unserializable([rehearsalsCommandGroup, rehearsalsQueryGroup])).toEqual([]);
    }),
  );
});
