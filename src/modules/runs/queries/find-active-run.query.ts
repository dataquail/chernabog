import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { FoundRun } from "../domain/run/run-view.value-object.ts";

// The persona's run in flight for the item, if it has one: a persona has at
// most one per flow and item.
export const FindActiveRunQuery = Query.make("FindActiveRunQuery", {
  payload: {
    repo: Schema.String,
    // None for the implicit persona.
    persona: Schema.Option(Schema.String),
    flow: Schema.String,
    itemKey: Schema.String,
  },
  success: FoundRun,
});

export type FindActiveRunPayload = Query.Payload<typeof FindActiveRunQuery>;
