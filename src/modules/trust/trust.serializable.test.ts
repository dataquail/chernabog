import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../test/effect-test.ts";
import { unserializable } from "../../../test/serializable.ts";
import { RepoTrusted } from "./domain/trust-record/trust-record.events.ts";
import { trustCommandGroup } from "./trust.command-handlers.ts";
import { trustQueryGroup } from "./trust.query-handlers.ts";

// The daemon's protocol and the dashboard carry the trust module's messages and events
// over JSON, so each must survive a round trip through it (ADR 15).
describe("the trust module's messages and events", () => {
  effect("all cross JSON", () =>
    Effect.gen(function* () {
      expect(yield* unserializable([trustCommandGroup, trustQueryGroup], { RepoTrusted })).toEqual(
        [],
      );
    }),
  );
});
