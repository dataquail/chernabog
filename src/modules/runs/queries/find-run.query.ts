import { Query } from "@effect-server-utils/cqrs";

import { RunId } from "../../../kernel/run-id.id.ts";
import { FoundRun } from "../domain/run/run-view.value-object.ts";

// The run with this id, if there is one.
export const FindRunQuery = Query.make("FindRunQuery", {
  payload: { runId: RunId },
  success: FoundRun,
});

export type FindRunPayload = Query.Payload<typeof FindRunQuery>;
