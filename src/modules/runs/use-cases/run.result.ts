import * as Schema from "effect/Schema";

import { RunView } from "../domain/run/run-view.value-object.ts";

// A run, a run in flight and the run asked for, as the use-cases that change
// one return them and the daemon's protocol carries them.
export { ActiveRun, FoundRun, RunView } from "../domain/run/run-view.value-object.ts";

// The runs in flight this binary mustn't resume, each with why.
export class UnsupportedRuns extends Schema.Class<
  UnsupportedRuns,
  { readonly brand: "UnsupportedRuns" }
>("UnsupportedRuns")({
  runs: Schema.Array(Schema.Struct({ run: RunView, reason: Schema.String })),
}) {}
