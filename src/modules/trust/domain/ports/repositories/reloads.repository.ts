import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type PersistenceFailed } from "../../../../../kernel/persistence.errors.ts";
import { type RepoSlug } from "../../../../../kernel/repo-slug.id.ts";
import { type ReloadRoot } from "../../reload/reload.root.ts";

// The tree each repo last restarted the daemon on, by slug. A store that
// can't be read has none, so `findOne` never fails: at worst a tree restarts
// the daemon once more.
export type ReloadsRepositoryService = {
  readonly findOne: (repo: RepoSlug) => Effect.Effect<Option.Option<ReloadRoot>>;
  readonly save: (record: ReloadRoot) => Effect.Effect<void, PersistenceFailed>;
};

export class ReloadsRepository extends Context.Service<
  ReloadsRepository,
  ReloadsRepositoryService
>()("ReloadsRepository") {}
