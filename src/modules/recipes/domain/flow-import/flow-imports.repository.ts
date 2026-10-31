import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type PersistenceFailed } from "../../../../kernel/persistence.errors.ts";
import { type Specification } from "../../../../kernel/specification.ts";
import { type FlowImportRoot } from "./flow-import.root.ts";

// The flows checkouts import from recipe packages. Each checkout keeps its own
// in its .chernabog/config.yaml, so a read names the checkout: a spec pins
// `root` (FlowImportSpecifications.inCheckout). `upsertOne` sets a flow's
// `from`, and `deleteOne` removes it, keeping the flow's other settings and
// the file's comments.
export type FlowImportsRepositoryService = {
  readonly findMany: (
    spec: Specification<FlowImportRoot>,
  ) => Effect.Effect<ReadonlyArray<FlowImportRoot>, PersistenceFailed>;
  readonly upsertOne: (flowImport: FlowImportRoot) => Effect.Effect<void, PersistenceFailed>;
  readonly deleteOne: (flowImport: FlowImportRoot) => Effect.Effect<void, PersistenceFailed>;
};

export class FlowImportsRepository extends Context.Service<
  FlowImportsRepository,
  FlowImportsRepositoryService
>()("FlowImportsRepository") {}
