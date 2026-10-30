import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { WorkItem } from "../domain/run/work-item.value-object.ts";
import { Delivered } from "../domain/run-wait/run-wait-view.value-object.ts";

// Wakes the persona's runs waiting on a signal its flow's trigger reported for
// their item, each wait once. A wait that wins a race of several signals
// takes the others in that race with it, so the run doesn't look parked after.
export const DeliverSignalsCommand = Command.make("DeliverSignalsCommand", {
  payload: {
    flow: Schema.Struct({
      repo: Schema.String,
      flow: Schema.String,
      persona: Schema.Option(Schema.String),
    }),
    items: Schema.Array(WorkItem),
  },
  success: Delivered,
});

export type DeliverSignalsPayload = Command.Payload<typeof DeliverSignalsCommand>;
