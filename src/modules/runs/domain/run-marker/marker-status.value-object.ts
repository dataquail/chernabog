import * as Schema from "effect/Schema";

// Where a hold is: held, until the run ends; released; kept, because the run
// ended in one of its keepOn endings; or unreleasable, because the flow no
// longer defines its release (or its arguments no longer fit), which is a
// person's to take off.
export const MarkerStatus = Schema.Literals(["held", "released", "kept", "unreleasable"]);

export type MarkerStatus = typeof MarkerStatus.Type;
