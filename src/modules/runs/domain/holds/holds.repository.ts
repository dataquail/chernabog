import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type HoldsRoot } from "../../holds/holds.root.ts";

// What each persona's flow holds: `save` replaces a flow's holds with the ones
// its latest tick found, and `findAll` reads every flow's that holds anything.
export type HoldsRepositoryService = {
  readonly findAll: Effect.Effect<ReadonlyArray<HoldsRoot>>;
  readonly save: (holds: HoldsRoot) => Effect.Effect<void>;
};

export class HoldsRepository extends Context.Service<HoldsRepository, HoldsRepositoryService>()(
  "HoldsRepository",
) {}
