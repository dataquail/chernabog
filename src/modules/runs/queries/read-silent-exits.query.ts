import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";

// How many runs of the run's item in a row, before it, ended because their
// spoke exited before saying how their run ended (ADR 23, decision 2): runs
// of the same repo, persona, flow and item, newest first, until one that
// ended any other way. A run its hub's restart interrupted is passed over,
// neither counted nor ending the count. What the hub stops repeating a
// phase that crashes every time by.
export const ReadSilentExitsQuery = Query.make("ReadSilentExitsQuery", {
  payload: { runId: RunId },
  success: Schema.Struct({ silentExits: Schema.Finite }),
});

export type ReadSilentExitsPayload = Query.Payload<typeof ReadSilentExitsQuery>;
