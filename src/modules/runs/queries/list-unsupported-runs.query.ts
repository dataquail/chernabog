import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunView } from "../domain/run/run-view.value-object.ts";

// The runs in flight this binary mustn't resume, each with why.
export class UnsupportedRuns extends Schema.Class<
  UnsupportedRuns,
  { readonly brand: "UnsupportedRuns" }
>("UnsupportedRuns")({
  runs: Schema.Array(Schema.Struct({ run: RunView, reason: Schema.String })),
}) {}

// The runs in flight, executing or parked on a signal, that started under an
// SDK this binary doesn't run, each with why it mustn't resume: what a
// composition root sends to a person at startup, rather than replay.
export const ListUnsupportedRunsQuery = Query.make("ListUnsupportedRunsQuery", {
  success: UnsupportedRuns,
});
