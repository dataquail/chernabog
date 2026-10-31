import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunStatus } from "./run-status.value-object.ts";

// Absent values cross the daemon's socket as null.
const Maybe = Schema.OptionFromNullOr(Schema.String);

const runFields = {
  id: RunId,
  // The repo's name as the daemon schedules it.
  repo: Schema.String,
  // The GitHub persona it acts as; null for the implicit one.
  persona: Maybe,
  flow: Schema.String,
  itemKey: Schema.String,
  itemTitle: Maybe,
  itemUrl: Maybe,
  executionId: Maybe,
  // The work items it named as its subjects, such as a pull request it
  // opened; none from a daemon from before runs named them.
  subjects: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
  status: RunStatus,
  currentStep: Maybe,
  summary: Maybe,
  // The @chernabog/core it started under; optional, as a daemon from before
  // runs kept it answers without.
  coreVersion: Schema.optionalKey(Schema.String),
  // The .chernabog/ tree it started from and resumes against; absent for a
  // run from a working copy, and from a daemon from before runs kept it.
  configTree: Schema.OptionFromOptionalKey(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeedNone),
  ),
  startedAt: Schema.String,
  finishedAt: Maybe,
};

// A run, as the CLI, the TUI and the daemon's log see it: what its queries
// answer and the use-cases that change one return.
export class RunView extends Schema.Class<RunView, { readonly brand: "RunView" }>("RunView")(
  runFields,
) {}

// A run still running, and whether it's parked on a signal, holding no slot.
export class ActiveRun extends Schema.Class<ActiveRun, { readonly brand: "ActiveRun" }>(
  "ActiveRun",
)({ ...runFields, parked: Schema.Boolean }) {}

// The run asked for, if there is one.
export class FoundRun extends Schema.Class<FoundRun, { readonly brand: "FoundRun" }>("FoundRun")({
  run: Schema.Option(RunView),
}) {}

// A run asked to start: the run it is (a new one, or the one already in
// flight for the item), and whether it's new.
export class StartedRun extends Schema.Class<StartedRun, { readonly brand: "StartedRun" }>(
  "StartedRun",
)({
  run: Schema.Option(RunView),
  started: Schema.Boolean,
}) {}

// The runs in flight this binary mustn't resume, each with why.
export class UnsupportedRuns extends Schema.Class<
  UnsupportedRuns,
  { readonly brand: "UnsupportedRuns" }
>("UnsupportedRuns")({
  runs: Schema.Array(Schema.Struct({ run: RunView, reason: Schema.String })),
}) {}

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
