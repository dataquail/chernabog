import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";

// A run, a run in flight and the run asked for, as the use-cases that change
// one return them and the daemon's protocol carries them.
export { ActiveRun, FoundRun, RunView } from "../domain/run/run-view.value-object.ts";

// The runs a persona adopted.
export class AdoptedRuns extends Schema.Class<AdoptedRuns, { readonly brand: "AdoptedRuns" }>(
  "AdoptedRuns",
)({
  runs: Schema.Array(RunId),
}) {}

// The runs a crash left recorded without a workflow: the ones whose workflow
// started now, the ones that ended because they can't start one (recorded
// before runs kept their work item), and the ones left as they are because
// this process hasn't loaded their flow.
export class RecoveredRuns extends Schema.Class<RecoveredRuns, { readonly brand: "RecoveredRuns" }>(
  "RecoveredRuns",
)({
  executed: Schema.Array(RunView),
  abandoned: Schema.Array(RunView),
  left: Schema.Array(RunView),
}) {}

// The runs in flight this binary mustn't resume, each with why.
export class UnsupportedRuns extends Schema.Class<
  UnsupportedRuns,
  { readonly brand: "UnsupportedRuns" }
>("UnsupportedRuns")({
  runs: Schema.Array(Schema.Struct({ run: RunView, reason: Schema.String })),
}) {}
