import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunView } from "../domain/run/run-view.value-object.ts";

export class RunList extends Schema.Class<RunList, { readonly brand: "RunList" }>("RunList")({
  runs: Schema.Array(RunView),
}) {}

// The latest runs, newest first, finished or not.
export const ListRecentRunsQuery = Query.make("ListRecentRunsQuery", {
  payload: { latest: Schema.Int },
  success: RunList,
});

export type ListRecentRunsPayload = Query.Payload<typeof ListRecentRunsQuery>;
