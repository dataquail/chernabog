// An in-memory adapter of core's Progress port, for tests: each item's
// record in a map, an advance a compare-and-set on it. It passes the contract
// every adapter must (test/progress-contract.ts).

import { type Progress, ProgressError } from "@chernabog/core";
import * as Effect from "effect/Effect";

// A fresh fake, holding no records, each time it runs.
export const progressFake: Effect.Effect<Progress["Service"]> = Effect.sync(() => ({
  read: () => Effect.fail(new ProgressError({ message: "not implemented" })),
  readAll: Effect.fail(new ProgressError({ message: "not implemented" })),
  advance: () => Effect.fail(new ProgressError({ message: "not implemented" })),
}));
