import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import { AmbiguousRunPrefix, RunNotNamed } from "../domain/run/run.errors.ts";

// The run a person named, by its whole id.
export class NamedRun extends Schema.Class<NamedRun, { readonly brand: "NamedRun" }>("NamedRun")({
  runId: RunId,
}) {}

// The run a person names by enough of its id, among the runs with a log, as
// `logs` and `attach` take it.
export const ResolveRunIdQuery = Query.make("ResolveRunIdQuery", {
  payload: { asked: Schema.String },
  success: NamedRun,
  failure: Schema.Union([RunNotNamed, AmbiguousRunPrefix]),
});

export type ResolveRunIdPayload = Query.Payload<typeof ResolveRunIdQuery>;
