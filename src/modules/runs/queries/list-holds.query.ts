import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { HoldView } from "../domain/holds/hold-view.value-object.ts";

export class HoldList extends Schema.Class<HoldList, { readonly brand: "HoldList" }>("HoldList")({
  holds: Schema.Array(HoldView),
}) {}

// The items every flow's latest tick held, and why, one view per item.
export const ListHoldsQuery = Query.make("ListHoldsQuery", { success: HoldList });
