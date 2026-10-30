import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import { RunWait } from "../domain/run-wait/run-wait-view.value-object.ts";

export class RunWaits extends Schema.Class<RunWaits, { readonly brand: "RunWaits" }>("RunWaits")({
  waits: Schema.Array(RunWait),
}) {}

// What a run waits on for one signal: the deferreds the signal wakes.
export const ListRunWaitsQuery = Query.make("ListRunWaitsQuery", {
  payload: { runId: RunId, signal: Schema.String },
  success: RunWaits,
});

export type ListRunWaitsPayload = Query.Payload<typeof ListRunWaitsQuery>;
