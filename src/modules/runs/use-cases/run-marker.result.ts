import * as Schema from "effect/Schema";

import { RunMarkerView } from "../domain/run-marker/run-marker-view.value-object.ts";

// A marker a run holds or held, as the use-cases that change one return it
// and the daemon's protocol carries it.
export { RunMarkerView } from "../domain/run-marker/run-marker-view.value-object.ts";

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
