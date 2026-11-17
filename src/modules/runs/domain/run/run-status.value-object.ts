import * as Schema from "effect/Schema";

// Where a run is in its life: running until its workflow completes, then one
// of the ways it can end, cancelled by a person before it could, or
// superseded: its work item went (closed, merged, claimed by another run)
// while it was in flight, or lost: another run took its work item over once
// its claim's lease expired, or ended at a park: it waited on a person or
// another system, which on a daemon as in a CI job ends the run (ADR 0021,
// decision 4); its record carries the wait, and a later run takes it up.
export const RunStatus = Schema.Literals([
  "running",
  "done",
  "skipped",
  "needs-human",
  "failed",
  "cancelled",
  "superseded",
  "lost",
  "ended-at-park",
]);

export type RunStatus = typeof RunStatus.Type;

// How a run's workflow can end it: lost when it finds, before a write,
// that its claim names another run.
export const RunEnding = Schema.Literals(["done", "skipped", "needs-human", "failed", "lost"]);

export type RunEnding = typeof RunEnding.Type;
