import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { WorkItem } from "./work-item.value-object.ts";

// Where a run is in its life: running until its workflow completes, then one
// of the ways it can end, cancelled by a person before it could, or
// superseded: its work item went (closed, merged, claimed by another run)
// while it was in flight, or lost: another run took its work item over once
// its claim's lease expired.
export const RunStatus = Schema.Literals([
  "running",
  "done",
  "skipped",
  "needs-human",
  "failed",
  "cancelled",
  "superseded",
  "lost",
]);

export type RunStatus = typeof RunStatus.Type;

// How a run's workflow can end it: lost when it finds, before a write,
// that its claim names another run.
export const RunEnding = Schema.Literals(["done", "skipped", "needs-human", "failed", "lost"]);

export type RunEnding = typeof RunEnding.Type;

// One run of a flow, as one persona, for one work item: the record of what it
// does and as whom, which the workflow journal doesn't keep. A dumb value; its
// lifecycle, and the rules it keeps, are RunRootOps.
export class RunRoot extends Schema.Class<RunRoot, { readonly brand: "RunRoot" }>("RunRoot")({
  id: RunId,
  // The repo's name as the daemon schedules it.
  repo: Schema.String,
  // The GitHub persona it acts as; none for the implicit one.
  persona: Schema.Option(Schema.String),
  flow: Schema.String,
  itemKey: Schema.String,
  itemTitle: Schema.Option(Schema.String),
  itemUrl: Schema.Option(Schema.String),
  // The work item as its trigger reported it, so a start a crash interrupted
  // can execute it again; none for a run recorded before runs kept it.
  item: Schema.Option(WorkItem),
  // The workflow execution that runs it, once the engine has started one.
  executionId: Schema.Option(Schema.String),
  status: RunStatus,
  // The work items it named as its subjects (Subjects.name), in the order it
  // named them, such as the pull request an issue's run opened: what ties
  // its runs to the others that share one.
  subjects: Schema.Array(Schema.String).pipe(Schema.withConstructorDefault(Effect.succeed([]))),
  // The step it's in while running.
  currentStep: Schema.Option(Schema.String),
  // How it ended, once it has.
  summary: Schema.Option(Schema.String),
  // The @chernabog/core version the binary that started it bundled: what its
  // workflow's journal was written under, so a binary that doesn't provide
  // that core's major, at that version or later, never resumes it.
  coreVersion: Schema.String,
  // The .chernabog/ tree it started from, whose snapshot it resumes against,
  // with the blocks that tree pinned, whatever the base branch has since;
  // none for a run from a working copy.
  configTree: Schema.Option(Schema.String).pipe(Schema.withConstructorDefault(Effect.succeedNone)),
  // ISO timestamps.
  startedAt: Schema.String,
  finishedAt: Schema.Option(Schema.String),
}) {}
