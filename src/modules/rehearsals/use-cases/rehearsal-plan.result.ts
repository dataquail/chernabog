import * as Schema from "effect/Schema";

import { StandIns } from "../../../kernel/stand-in.value-object.ts";

// What answers for the agent in a rehearsal, by step.
export class RehearsalPlan extends Schema.Class<RehearsalPlan, { readonly brand: "RehearsalPlan" }>(
  "RehearsalPlan",
)({
  standIns: StandIns,
}) {}
