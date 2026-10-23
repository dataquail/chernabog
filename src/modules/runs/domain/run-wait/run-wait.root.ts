import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";

// A run parked on a signal, such as a review waiting for its author's push:
// the durable deferred that wakes it, and the token that completes it. A
// parked run holds no slot. One run may wait on several deferreds; each is
// its own wait.
export class RunWaitRoot extends Schema.Class<RunWaitRoot, { readonly brand: "RunWaitRoot" }>(
  "RunWaitRoot",
)({
  runId: RunId,
  signal: Schema.String,
  deferred: Schema.String,
  token: Schema.String,
}) {}
