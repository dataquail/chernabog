import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type PersistenceFailed } from "../../../../kernel/persistence.errors.ts";
import { type Specification } from "../../../../kernel/specification.ts";
import { type EnrolledRepoRoot } from "./enrolled-repo.root.ts";

// The repos enrolled on this machine. `findMany` reads them as they are stored
// now, every time, since the daemon, the CLI and the person's editor all
// write them; `upsertOne` stores one, matched to its entry by slug and, among
// clones, name, or as a new entry when none matches; `deleteOne` drops one's
// entry, settings and all.
export type EnrolledReposRepositoryService = {
  readonly findMany: (
    spec: Specification<EnrolledRepoRoot>,
  ) => Effect.Effect<ReadonlyArray<EnrolledRepoRoot>, PersistenceFailed>;
  readonly upsertOne: (repo: EnrolledRepoRoot) => Effect.Effect<void, PersistenceFailed>;
  readonly deleteOne: (repo: EnrolledRepoRoot) => Effect.Effect<void, PersistenceFailed>;
};

export class EnrolledReposRepository extends Context.Service<
  EnrolledReposRepository,
  EnrolledReposRepositoryService
>()("EnrolledReposRepository") {}
