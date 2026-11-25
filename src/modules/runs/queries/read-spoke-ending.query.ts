import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";

// How a spoke said its run ended, as the hub reads it once the spoke has
// exited (ADR 23, decision 2): none when it exited before it said, as a
// crash, a kill or a stop leaves it.
export class SpokeEndingRead extends Schema.Class<
  SpokeEndingRead,
  { readonly brand: "SpokeEndingRead" }
>("SpokeEndingRead")({
  ending: Schema.Option(
    Schema.Struct({
      status: Schema.Literals([
        "done",
        "skipped",
        "needs-human",
        "failed",
        "lost",
        "ended-at-park",
      ]),
      summary: Schema.String,
    }),
  ),
}) {}

// The last ending a run's spoke reported in the run's journal.
export const ReadSpokeEndingQuery = Query.make("ReadSpokeEndingQuery", {
  payload: { runId: RunId },
  success: SpokeEndingRead,
});

export type ReadSpokeEndingPayload = Query.Payload<typeof ReadSpokeEndingQuery>;
