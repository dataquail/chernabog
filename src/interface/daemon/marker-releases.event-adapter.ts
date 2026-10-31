// How the daemon learns what a run's ending released: not yet.

import { EventBus } from "@effect-server-utils/cqrs";
import * as Effect from "effect/Effect";

import { type MarkerReleases } from "../../modules/runs/runs.platform.ts";

export const subscribeMarkerReleases = (
  _react: (releases: MarkerReleases) => Effect.Effect<void>,
) => EventBus.use(() => Effect.void);
