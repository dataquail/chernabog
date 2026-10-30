import { Query } from "@effect-server-utils/cqrs";

import { HoldList } from "../domain/holds/hold-view.value-object.ts";

// The items every flow's latest tick held, and why, one view per item.
export const ListHoldsQuery = Query.make("ListHoldsQuery", { success: HoldList });
