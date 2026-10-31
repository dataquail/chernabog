import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { MarkerStatus } from "./marker-status.value-object.ts";

// A marker a run put on an item outside chernabog, such as a label, held by
// its definition's name with the JSON arguments its release takes. A run
// holds a name and arguments once. While a release keeps failing, it says
// how often, why last, and when it is tried again.
export class RunMarkerRoot extends Schema.Class<RunMarkerRoot, { readonly brand: "RunMarkerRoot" }>(
  "RunMarkerRoot",
)({
  runId: RunId,
  name: Schema.String,
  args: Schema.Json,
  // The run endings on which it stays.
  keepOn: Schema.Array(Schema.String),
  status: MarkerStatus,
  // ISO timestamps.
  heldAt: Schema.String,
  attempts: Schema.Finite,
  lastError: Schema.Option(Schema.String),
  nextAttemptAt: Schema.Option(Schema.String),
  settledAt: Schema.Option(Schema.String),
}) {}
