import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type PersistenceFailed } from "../../../../../kernel/persistence.errors.ts";
import { type EnrolledRepoRoot } from "../../enrolled-repo/enrolled-repo.root.ts";

// The repos enrolled on this machine. `findAll` reads them as they are stored
// now, every time, since the daemon, the CLI and the person's editor all
// write them; `save` stores one, matched to its entry by slug and, among
// clones, name, or as a new entry when none matches; `remove` drops one's
// entry, settings and all.
export type EnrolledReposRepositoryService = {
  readonly findAll: Effect.Effect<ReadonlyArray<EnrolledRepoRoot>, PersistenceFailed>;
  readonly save: (repo: EnrolledRepoRoot) => Effect.Effect<void, PersistenceFailed>;
  readonly remove: (repo: EnrolledRepoRoot) => Effect.Effect<void, PersistenceFailed>;
};

export class EnrolledReposRepository extends Context.Service<
  EnrolledReposRepository,
  EnrolledReposRepositoryService
>()("EnrolledReposRepository") {}
