import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../test/effect-test.ts";
import { unserializable } from "../../../test/serializable.ts";
import {
  RepoEnrolled,
  RepoPaused,
  RepoResumed,
  RepoUnenrolled,
} from "./domain/enrolled-repo/enrolled-repo.events.ts";
import { enrollmentCommandGroup } from "./enrollment.command-handlers.ts";
import { enrollmentQueryGroup } from "./enrollment.query-handlers.ts";

// The daemon's protocol and the dashboard carry the enrollment module's messages and events
// over JSON, so each must survive a round trip through it (ADR 15).
describe("the enrollment module's messages and events", () => {
  effect("all cross JSON", () =>
    Effect.gen(function* () {
      expect(
        yield* unserializable([enrollmentCommandGroup, enrollmentQueryGroup], {
          RepoEnrolled,
          RepoPaused,
          RepoResumed,
          RepoUnenrolled,
        }),
      ).toEqual([]);
    }),
  );
});
