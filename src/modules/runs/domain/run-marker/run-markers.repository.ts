import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type RunId } from "../../../../../kernel/run-id.id.ts";
import { type MarkerStatus, type RunMarkerRoot } from "../../run-marker/run-marker.root.ts";

// Which markers to read: one run's, or every run's, and only those in one status.
export type MarkerQuery = {
  readonly runId: Option.Option<RunId>;
  readonly status: Option.Option<MarkerStatus>;
};

// The markers runs hold, in the order they were held. A marker is one run's
// name and arguments, so saving one replaces the run's marker of the same
// name and arguments, keeping its place in that order.
export type RunMarkersRepositoryService = {
  readonly findAll: (query: MarkerQuery) => Effect.Effect<ReadonlyArray<RunMarkerRoot>>;
  readonly save: (marker: RunMarkerRoot) => Effect.Effect<void>;
  readonly remove: (marker: RunMarkerRoot) => Effect.Effect<void>;
};

export class RunMarkersRepository extends Context.Service<
  RunMarkersRepository,
  RunMarkersRepositoryService
>()("RunMarkersRepository") {}
