import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import { RunWait } from "../domain/run-wait/run-wait-view.value-object.ts";

// Parks a run on a signal its flow's trigger will report, such as a push to a
// review's pull request, with the durable deferred and token that wake it. A
// parked run holds no slot until it wakes. The wait keeps when it parked, for
// a person to see how long it has waited.
export const ParkRunCommand = Command.make("ParkRunCommand", {
  payload: {
    runId: RunId,
    signal: Schema.String,
    deferred: Schema.String,
    token: Schema.String,
  },
  success: RunWait,
});

export type ParkRunPayload = Command.Payload<typeof ParkRunCommand>;
