import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { TickPlan } from "../domain/schedule/tick.value-object.ts";

// One tick of a persona's flow, up to what it would do: unless the machine's
// gates hold it back, runs the flow's trigger, and says which of the work it
// found carries signals for runs in flight and which this machine may start
// runs for, as many as the limits let it. Why it would start nothing, when it
// wouldn't, is recorded as a skip; the items the trigger holds, and why,
// replace the flow's holds, and start nothing. Delivering the signals, the
// flow's own gate and starting the runs are left to the caller.
//
// Besides the flow, a tick weighs whether to apply the machine's gates (a
// person running a flow now skips them), an item a person named, the
// conditions the gates read, and the limits on runs at once.
export const PlanTickCommand = Command.make("PlanTickCommand", {
  payload: {
    flow: Schema.Struct({
      repo: Schema.String,
      flow: Schema.String,
      persona: Schema.Option(Schema.String),
    }),
    gates: Schema.Boolean,
    item: Schema.Option(Schema.String),
    conditions: Schema.Struct({
      enabled: Schema.Boolean,
      flowOff: Schema.Option(Schema.String),
      paused: Schema.Boolean,
      quietHours: Schema.Option(Schema.String),
      activeHours: Schema.Option(Schema.String),
    }),
    concurrency: Schema.Struct({ flow: Schema.Int, machine: Schema.Int }),
  },
  success: TickPlan,
});

export type PlanTickPayload = Command.Payload<typeof PlanTickCommand>;
