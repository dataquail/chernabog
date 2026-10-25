// A wait as om_waits stores it.

import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunWaitRoot } from "../../domain/run-wait/run-wait.root.ts";

export const WaitColumns = Schema.Struct({
  run_id: Schema.String,
  signal: Schema.String,
  deferred: Schema.String,
  token: Schema.String,
  parked_at: Schema.OptionFromNullOr(Schema.String),
});

export const toRoot = (row: typeof WaitColumns.Type) =>
  RunWaitRoot.make({
    runId: RunId.make(row.run_id),
    signal: row.signal,
    deferred: row.deferred,
    token: row.token,
    parkedAt: row.parked_at,
  });
