import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type Specification } from "../../../../kernel/specification.ts";
import { type RunSpokeRoot } from "./run-spoke.root.ts";

// The records of the hub's live spokes, read by a spec
// (RunSpokeSpecifications). A run has at most one spoke, so upserting one
// replaces the run's.
export type RunSpokesRepositoryService = {
  readonly findOne: (
    spec: Specification<RunSpokeRoot>,
  ) => Effect.Effect<Option.Option<RunSpokeRoot>>;
  readonly findMany: (
    spec: Specification<RunSpokeRoot>,
  ) => Effect.Effect<ReadonlyArray<RunSpokeRoot>>;
  readonly upsertOne: (spoke: RunSpokeRoot) => Effect.Effect<void>;
  readonly deleteOne: (spoke: RunSpokeRoot) => Effect.Effect<void>;
};

export class RunSpokesRepository extends Context.Service<
  RunSpokesRepository,
  RunSpokesRepositoryService
>()("RunSpokesRepository") {}
