import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import { RunStatus } from "../domain/run/run.root.ts";

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
  status: RunStatus,
  currentStep: Maybe,
  summary: Maybe,
  startedAt: Schema.String,
  finishedAt: Maybe,
};

// A run, as the CLI, the TUI and the daemon's log see it.
export class RunView extends Schema.Class<RunView, { readonly brand: "RunView" }>("RunView")(
  runFields,
) {}

// A run still running, and whether it's parked on a signal, holding no slot.
export class ActiveRun extends Schema.Class<ActiveRun, { readonly brand: "ActiveRun" }>(
  "ActiveRun",
)({ ...runFields, parked: Schema.Boolean }) {}

export class RunList extends Schema.Class<RunList, { readonly brand: "RunList" }>("RunList")({
  runs: Schema.Array(RunView),
}) {}

export class ActiveRuns extends Schema.Class<ActiveRuns, { readonly brand: "ActiveRuns" }>(
  "ActiveRuns",
)({
  runs: Schema.Array(ActiveRun),
}) {}

// The run asked for, if there is one.
export class FoundRun extends Schema.Class<FoundRun, { readonly brand: "FoundRun" }>("FoundRun")({
  run: Schema.Option(RunView),
}) {}

// The runs a persona adopted.
export class AdoptedRuns extends Schema.Class<AdoptedRuns, { readonly brand: "AdoptedRuns" }>(
  "AdoptedRuns",
)({
  runs: Schema.Array(RunId),
}) {}
