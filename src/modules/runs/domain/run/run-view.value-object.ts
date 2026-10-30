import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunStatus } from "./run.root.ts";

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

// The runs in flight this binary mustn't resume, each with why.
export class UnsupportedRuns extends Schema.Class<
  UnsupportedRuns,
  { readonly brand: "UnsupportedRuns" }
>("UnsupportedRuns")({
  runs: Schema.Array(Schema.Struct({ run: RunView, reason: Schema.String })),
}) {}
