// How the daemon learns what a run's ending released: from RunMarkersReleased,
// which the runs' release-run-markers reaction dispatches, rather than only
// from its own sweep's result (docs/adr/0013-event-handlers.md).

import { EventBus } from "@effect-server-utils/cqrs";
import type * as Effect from "effect/Effect";

import { type MarkerReleases, RunMarkersReleased } from "../../modules/runs/runs.platform.ts";

// Subscribes `react` to what each run's ending released, kept, failed to
// release and found unreleasable, after it commits. A repeat (the same
// eventId) reaches it once.
export const subscribeMarkerReleases = (react: (releases: MarkerReleases) => Effect.Effect<void>) =>
  EventBus.use((bus) =>
    bus.subscribeAfterCommit(RunMarkersReleased, (event) => react(event.releases), {
      name: "daemon/marker-releases",
    }),
  );
