import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type Specification } from "../../../../kernel/specification.ts";
import { type RunMarkerRoot } from "./run-marker.root.ts";

// The markers runs hold, read by a spec (RunMarkerSpecifications) in the order
// they were held. A marker is one run's name and arguments, so upserting one
// replaces the run's marker of the same name and arguments, keeping its place
// in that order.
export type RunMarkersRepositoryService = {
  readonly findMany: (
    spec: Specification<RunMarkerRoot>,
  ) => Effect.Effect<ReadonlyArray<RunMarkerRoot>>;
  readonly upsertOne: (marker: RunMarkerRoot) => Effect.Effect<void>;
  readonly deleteOne: (marker: RunMarkerRoot) => Effect.Effect<void>;
};

export class RunMarkersRepository extends Context.Service<
  RunMarkersRepository,
  RunMarkersRepositoryService
>()("RunMarkersRepository") {}
