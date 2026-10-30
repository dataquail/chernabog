import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import { RunWaits } from "../domain/run-wait/run-wait-view.value-object.ts";

// What a run waits on for one signal: the deferreds the signal wakes.
export const ListRunWaitsQuery = Query.make("ListRunWaitsQuery", {
  payload: { runId: RunId, signal: Schema.String },
  success: RunWaits,
});

export type ListRunWaitsPayload = Query.Payload<typeof ListRunWaitsQuery>;
