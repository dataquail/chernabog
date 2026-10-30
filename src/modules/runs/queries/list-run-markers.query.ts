import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import { RunMarkers } from "../domain/run-marker/run-marker-view.value-object.ts";

// The markers a run still holds, in the order it held them; with a name, only those of it.
export const ListRunMarkersQuery = Query.make("ListRunMarkersQuery", {
  payload: { runId: RunId, name: Schema.Option(Schema.String) },
  success: RunMarkers,
});

export type ListRunMarkersPayload = Query.Payload<typeof ListRunMarkersQuery>;
