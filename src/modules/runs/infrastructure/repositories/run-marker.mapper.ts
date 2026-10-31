// A marker as om_markers stores it.

import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { MarkerStatus } from "../../domain/run-marker/marker-status.value-object.ts";
import { RunMarkerRoot } from "../../domain/run-marker/run-marker.root.ts";

const JsonText = Schema.fromJsonString(Schema.Json);

export const MarkerColumns = Schema.Struct({
  run_id: Schema.String,
  name: Schema.String,
  args: JsonText,
  keep_on: Schema.fromJsonString(Schema.Array(Schema.String)),
  status: MarkerStatus,
  held_at: Schema.String,
  attempts: Schema.Finite,
  last_error: Schema.OptionFromNullOr(Schema.String),
  next_attempt_at: Schema.OptionFromNullOr(Schema.String),
  settled_at: Schema.OptionFromNullOr(Schema.String),
});

export const toRoot = (row: typeof MarkerColumns.Type) =>
  RunMarkerRoot.make({
    runId: RunId.make(row.run_id),
    name: row.name,
    args: row.args,
    keepOn: row.keep_on,
    status: row.status,
    heldAt: row.held_at,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    settledAt: row.settled_at,
  });

export const toRow = (marker: RunMarkerRoot) =>
  Schema.encodeSync(MarkerColumns)({
    run_id: marker.runId,
    name: marker.name,
    args: marker.args,
    keep_on: marker.keepOn,
    status: marker.status,
    held_at: marker.heldAt,
    attempts: marker.attempts,
    last_error: marker.lastError,
    next_attempt_at: marker.nextAttemptAt,
    settled_at: marker.settledAt,
  });
