import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";

// The run a person named, by its whole id.
export class NamedRun extends Schema.Class<NamedRun, { readonly brand: "NamedRun" }>("NamedRun")({
  runId: RunId,
}) {}

// A run's log as it is now, and where it's kept.
export class RunLog extends Schema.Class<RunLog, { readonly brand: "RunLog" }>("RunLog")({
  runId: RunId,
  path: Schema.String,
  text: Schema.String,
}) {}
