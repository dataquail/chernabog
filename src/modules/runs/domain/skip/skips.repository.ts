import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type Specification } from "../../../../kernel/specification.ts";
import { type SkipRoot } from "./skip.root.ts";

// Why ticks started nothing, as a log: `insertOne` adds a skip, and
// `findMany` reads those a spec (SkipSpecifications) holds of, newest first.
export type SkipsRepositoryService = {
  readonly findMany: (spec: Specification<SkipRoot>) => Effect.Effect<ReadonlyArray<SkipRoot>>;
  readonly insertOne: (skip: SkipRoot) => Effect.Effect<void>;
};

export class SkipsRepository extends Context.Service<SkipsRepository, SkipsRepositoryService>()(
  "SkipsRepository",
) {}
