import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";

// The reports a run's spoke wrote in its journal after the one the hub last
// folded, in order: what the hub tails and folds into state.db (ADR 23,
// decisions 3 and 8). None for a run with no journal.
export class SpokeReportsRead extends Schema.Class<
  SpokeReportsRead,
  { readonly brand: "SpokeReportsRead" }
>("SpokeReportsRead")({
  // Each as the journal holds it: its place in the journal's order, when the
  // spoke wrote it, its command's tag, and that command's payload as JSON.
  reports: Schema.Array(
    Schema.Struct({
      seq: Schema.Finite,
      at: Schema.String,
      tag: Schema.String,
      payload: Schema.String,
    }),
  ),
}) {}

// A run's spoke's reports after `after`, the last `seq` the hub folded.
export const ReadSpokeReportsQuery = Query.make("ReadSpokeReportsQuery", {
  payload: { runId: RunId, after: Schema.Finite },
  success: SpokeReportsRead,
});

export type ReadSpokeReportsPayload = Query.Payload<typeof ReadSpokeReportsQuery>;
