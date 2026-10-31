import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../test/effect-test.ts";
import { unserializable } from "../../../test/serializable.ts";
import { recipesCommandGroup } from "./recipes.command-handlers.ts";
import { recipesQueryGroup } from "./recipes.query-handlers.ts";

// The daemon's protocol and the dashboard carry the recipes module's messages
// over JSON, so each must survive a round trip through it (ADR 13).
describe("the recipes module's messages", () => {
  effect("all cross JSON", () =>
    Effect.gen(function* () {
      expect(yield* unserializable([recipesCommandGroup, recipesQueryGroup])).toEqual([]);
    }),
  );
});
