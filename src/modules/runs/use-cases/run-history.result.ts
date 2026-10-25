import * as Schema from "effect/Schema";

import { RunWait } from "./run-wait.result.ts";

// A step a run entered, and when.
export class RunStep extends Schema.Class<RunStep, { readonly brand: "RunStep" }>("RunStep")({
  step: Schema.String,
  enteredAt: Schema.String,
}) {}

// Where a run has been and what it waits on: the steps it entered, in order,
// none for a run from before steps were kept, and the signals it's parked on.
export class RunHistory extends Schema.Class<RunHistory, { readonly brand: "RunHistory" }>(
  "RunHistory",
)({
  steps: Schema.Array(RunStep),
  waits: Schema.Array(RunWait),
}) {}
