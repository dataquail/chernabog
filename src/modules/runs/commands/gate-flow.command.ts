import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { Gated } from "../domain/skip/skip-view.value-object.ts";

// Asks a flow's own gate whether it may start a run for an item now. It is
// asked before each run a tick starts, since a run started may close it. Why
// it holds the run back, when it does, is recorded as a skip.
export const GateFlowCommand = Command.make("GateFlowCommand", {
  payload: {
    flow: Schema.Struct({
      repo: Schema.String,
      flow: Schema.String,
      persona: Schema.Option(Schema.String),
    }),
    itemKey: Schema.String,
  },
  success: Gated,
});

export type GateFlowPayload = Command.Payload<typeof GateFlowCommand>;
