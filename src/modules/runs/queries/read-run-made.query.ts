import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";

// What a run made on its repo, as its journal recorded it: the issues it
// created, in the order it did, and each claim ref it took, by the item it
// claims and the run the claim names, whether it still holds it or not.
export class RunMade extends Schema.Class<RunMade, { readonly brand: "RunMade" }>("RunMade")({
  createdIssues: Schema.Array(Schema.Finite),
  claims: Schema.Array(Schema.Struct({ item: Schema.String, runId: Schema.String })),
}) {}

// What a run made on its repo, from its own journal alone: the issues it
// created and the claim refs it took, for what cleans up after it, such as a
// rehearsal, without searching the repo for anything that looks related.
export const ReadRunMadeQuery = Query.make("ReadRunMadeQuery", {
  payload: { runId: RunId },
  success: RunMade,
});

export type ReadRunMadePayload = Query.Payload<typeof ReadRunMadeQuery>;
