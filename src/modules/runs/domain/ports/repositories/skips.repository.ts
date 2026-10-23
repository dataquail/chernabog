import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type SkipRoot } from "../../skip/skip.root.ts";

// Why ticks started nothing, as a log: `save` adds a skip, and `findAll` reads
// the latest `latest`, newest first.
export type SkipsRepositoryService = {
  readonly findAll: (latest: number) => Effect.Effect<ReadonlyArray<SkipRoot>>;
  readonly save: (skip: SkipRoot) => Effect.Effect<void>;
};

export class SkipsRepository extends Context.Service<SkipsRepository, SkipsRepositoryService>()(
  "SkipsRepository",
) {}
