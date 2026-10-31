import { Command } from "@effect-server-utils/cqrs";

import { MarkerReleases } from "../domain/run-marker/run-marker-view.value-object.ts";

// Releases what ended runs still hold, as each run's persona, through its
// flow as this process loaded it (the base branch's): each run's markers
// newest first, keeping those whose keepOn names the run's ending. A release
// that fails stays held, to try again after a backoff; one the flow no
// longer defines is unreleasable, for a person. A run in flight keeps its
// markers, and a release not yet due waits. Safe to repeat: a release that
// ran before a crash runs again.
export const ReleaseMarkersCommand = Command.make("ReleaseMarkersCommand", {
  success: MarkerReleases,
});
