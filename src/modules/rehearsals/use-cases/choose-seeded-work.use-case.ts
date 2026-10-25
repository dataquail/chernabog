import * as Effect from "effect/Effect";

import { ScenarioRootOps } from "../domain/scenario/scenario.root-ops.ts";
import { type Seeded } from "../domain/scenario/seeded.value-object.ts";

// The work items, by key, that are about what seeding made: all a rehearsal
// may run on, even on a repo with real work queued.
export const chooseSeededWorkUseCase = Effect.fn("chooseSeededWorkUseCase")(function* (
  seeded: Seeded,
  keys: ReadonlyArray<string>,
) {
  return yield* Effect.sync(() => keys.filter((key) => ScenarioRootOps.isSeeded(seeded, key)));
});
