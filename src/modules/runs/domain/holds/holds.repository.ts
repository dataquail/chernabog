import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type Specification } from "../../../../kernel/specification.ts";
import { type HoldsRoot } from "./holds.root.ts";

// What each persona's flow holds: `upsertOne` replaces a flow's holds with the
// ones its latest tick found, and `findMany` reads those of every flow a spec
// (HoldsSpecifications) holds of that holds anything.
export type HoldsRepositoryService = {
  readonly findMany: (spec: Specification<HoldsRoot>) => Effect.Effect<ReadonlyArray<HoldsRoot>>;
  readonly upsertOne: (holds: HoldsRoot) => Effect.Effect<void>;
};

export class HoldsRepository extends Context.Service<HoldsRepository, HoldsRepositoryService>()(
  "HoldsRepository",
) {}
