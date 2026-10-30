import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";

// A run's wait on a signal: the deferred that wakes it, its token, and when
// it parked, if the wait kept it. Absent values cross the daemon's socket as null.
export class RunWait extends Schema.Class<RunWait, { readonly brand: "RunWait" }>("RunWait")({
  runId: RunId,
  signal: Schema.String,
  deferred: Schema.String,
  token: Schema.String,
  parkedAt: Schema.OptionFromNullOr(Schema.String),
}) {}
