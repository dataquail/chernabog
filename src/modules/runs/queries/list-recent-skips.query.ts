import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { SkipView } from "../domain/skip/skip-view.value-object.ts";

export class SkipList extends Schema.Class<SkipList, { readonly brand: "SkipList" }>("SkipList")({
  skips: Schema.Array(SkipView),
}) {}

// The latest skips, newest first.
export const ListRecentSkipsQuery = Query.make("ListRecentSkipsQuery", {
  payload: { latest: Schema.Int },
  success: SkipList,
});

export type ListRecentSkipsPayload = Query.Payload<typeof ListRecentSkipsQuery>;
