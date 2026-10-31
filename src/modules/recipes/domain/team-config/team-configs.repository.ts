import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type PersistenceFailed } from "../../../../kernel/persistence.errors.ts";
import { type Specification } from "../../../../kernel/specification.ts";
import { type TeamConfigRoot } from "./team-config.root.ts";

// The team's config of each checkout. Each checkout keeps its own in its
// .chernabog/config.yaml, so a read names the checkout: a spec pins `root`
// (TeamConfigSpecifications.ofCheckout). A checkout without the file has a
// config that says nothing.
export type TeamConfigsRepositoryService = {
  readonly findOne: (
    spec: Specification<TeamConfigRoot>,
  ) => Effect.Effect<Option.Option<TeamConfigRoot>, PersistenceFailed>;
};

export class TeamConfigsRepository extends Context.Service<
  TeamConfigsRepository,
  TeamConfigsRepositoryService
>()("TeamConfigsRepository") {}
