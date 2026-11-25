import * as Schema from "effect/Schema";

// How a spoke says its run ended, as the last report in its journal (ADR 23,
// decisions 2 and 3): an ending its workflow reached, or ended at its park.
// The hub ends the run with it once the spoke has exited.
export const SpokeEnding = Schema.Struct({
  status: Schema.Literals(["done", "skipped", "needs-human", "failed", "lost", "ended-at-park"]),
  summary: Schema.String,
});

export type SpokeEnding = typeof SpokeEnding.Type;
