import { Event } from "@effect-server-utils/cqrs";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { MarkerReleases } from "./run-marker-view.value-object.ts";

// What releasing a run's markers did as the run ended: released, kept on its
// ending, failed (for the sweep to try again), and found unreleasable, for a
// person. A run's ending releases its markers once, so the event's id is the
// run's; a repeat has the same id, for a consumer to drop.
export const RunMarkersReleased = Event.make("RunMarkersReleased", {
  eventId: Schema.String,
  runId: RunId,
  releases: MarkerReleases,
});

export type RunMarkersReleased = typeof RunMarkersReleased.Type;

// What the release said, when it settled anything; none when it found nothing to do.
const released = (runId: RunId, releases: MarkerReleases) =>
  Option.liftPredicate(
    RunMarkersReleased.make({ eventId: `${runId}:markers`, runId, releases }),
    () =>
      [releases.released, releases.kept, releases.failed, releases.unreleasable].some(
        (settled) => settled.length > 0,
      ),
  );

export const RunMarkerEvents = { released } as const;
