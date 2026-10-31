import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { ActiveRun } from "../domain/run/run-view.value-object.ts";

export class ActiveRuns extends Schema.Class<ActiveRuns, { readonly brand: "ActiveRuns" }>(
  "ActiveRuns",
)({
  runs: Schema.Array(ActiveRun),
}) {}

// The runs in flight, oldest first, each with whether it's parked on a
// signal, so it holds no slot. Each set field narrows them; a persona of none
// is the implicit one.
export const ListActiveRunsQuery = Query.make("ListActiveRunsQuery", {
  payload: {
    repo: Schema.Option(Schema.String),
    persona: Schema.Option(Schema.Option(Schema.String)),
    flow: Schema.Option(Schema.String),
  },
  success: ActiveRuns,
});

export type ListActiveRunsPayload = Query.Payload<typeof ListActiveRunsQuery>;
