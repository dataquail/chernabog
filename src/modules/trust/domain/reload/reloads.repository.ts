import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type PersistenceFailed } from "../../../../kernel/persistence.errors.ts";
import { type Specification } from "../../../../kernel/specification.ts";
import { type ReloadRoot } from "./reload.root.ts";

// The tree each repo last restarted the daemon on, one per slug. A store that
// can't be read has none, so `findOne` never fails: at worst a tree restarts
// the daemon once more. `upsertOne` replaces the repo's reload, or adds it.
export type ReloadsRepositoryService = {
  readonly findOne: (spec: Specification<ReloadRoot>) => Effect.Effect<Option.Option<ReloadRoot>>;
  readonly upsertOne: (record: ReloadRoot) => Effect.Effect<void, PersistenceFailed>;
};

export class ReloadsRepository extends Context.Service<
  ReloadsRepository,
  ReloadsRepositoryService
>()("ReloadsRepository") {}
