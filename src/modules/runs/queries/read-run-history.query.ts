import { Query } from "@effect-server-utils/cqrs";

import { RunId } from "../../../kernel/run-id.id.ts";
import { RunHistory } from "../domain/run-step/run-history.value-object.ts";

// The steps a run has entered and the signals it waits on, for a person
// looking at where it has been.
export const ReadRunHistoryQuery = Query.make("ReadRunHistoryQuery", {
  payload: { runId: RunId },
  success: RunHistory,
});

export type ReadRunHistoryPayload = Query.Payload<typeof ReadRunHistoryQuery>;
