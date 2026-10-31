import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

export class StateVersion extends Schema.Class<StateVersion, { readonly brand: "StateVersion" }>(
  "StateVersion",
)({
  version: Schema.Int,
}) {}

// state.db's version as this process's connection sees it: it moves when
// another connection (a foreground run's, a rehearsal's) commits a change, and
// never for one this process made, so the daemon can tell the two apart.
export const ReadStateVersionQuery = Query.make("ReadStateVersionQuery", {
  success: StateVersion,
});
