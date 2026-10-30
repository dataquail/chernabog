import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";

// A run's log as it is now, and where it's kept.
export class RunLog extends Schema.Class<RunLog, { readonly brand: "RunLog" }>("RunLog")({
  runId: RunId,
  path: Schema.String,
  text: Schema.String,
}) {}
