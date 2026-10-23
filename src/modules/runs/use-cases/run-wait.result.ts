import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";

// A run's wait on a signal: the deferred that wakes it and its token.
export class RunWait extends Schema.Class<RunWait, { readonly brand: "RunWait" }>("RunWait")({
  runId: RunId,
  signal: Schema.String,
  deferred: Schema.String,
  token: Schema.String,
}) {}

export class RunWaits extends Schema.Class<RunWaits, { readonly brand: "RunWaits" }>("RunWaits")({
  waits: Schema.Array(RunWait),
}) {}
