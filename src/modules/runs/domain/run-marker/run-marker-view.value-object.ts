import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { MarkerStatus } from "./run-marker.root.ts";

// A marker a run holds or held: its name and arguments, where its release
// is, and, while a release keeps failing, how often, why last, and when it's
// tried again. Absent values cross the daemon's socket as null.
export class RunMarkerView extends Schema.Class<RunMarkerView, { readonly brand: "RunMarkerView" }>(
  "RunMarkerView",
)({
  runId: RunId,
  name: Schema.String,
  args: Schema.Json,
  keepOn: Schema.Array(Schema.String),
  status: MarkerStatus,
  heldAt: Schema.String,
  attempts: Schema.Finite,
  lastError: Schema.OptionFromNullOr(Schema.String),
  nextAttemptAt: Schema.OptionFromNullOr(Schema.String),
}) {}

export class RunMarkers extends Schema.Class<RunMarkers, { readonly brand: "RunMarkers" }>(
  "RunMarkers",
)({
  markers: Schema.Array(RunMarkerView),
}) {}

// What releasing ended runs' markers did: released, kept on the run's
// ending, failed (to try again), and found unreleasable, for a person.
export class MarkerReleases extends Schema.Class<
  MarkerReleases,
  { readonly brand: "MarkerReleases" }
>("MarkerReleases")({
  released: Schema.Array(RunMarkerView),
  kept: Schema.Array(RunMarkerView),
  failed: Schema.Array(RunMarkerView),
  unreleasable: Schema.Array(RunMarkerView),
}) {}
