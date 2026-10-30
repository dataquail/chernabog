import { Query } from "@effect-server-utils/cqrs";

import { UnsupportedRuns } from "../domain/run/run-view.value-object.ts";

// The runs in flight, executing or parked on a signal, that started under an
// SDK this binary doesn't run, each with why it mustn't resume: what a
// composition root sends to a person at startup, rather than replay.
export const ListUnsupportedRunsQuery = Query.make("ListUnsupportedRunsQuery", {
  success: UnsupportedRuns,
});
