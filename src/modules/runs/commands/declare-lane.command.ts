import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";

// A run's flow declaring that one of its lanes waited on others (core's
// Lanes.declare). What a lane needs only grows: a lane it names again, as a
// resumed run's workflow body declares it again, changes nothing.
export const DeclareLaneCommand = Command.make("DeclareLaneCommand", {
  payload: { runId: RunId, lane: Schema.String, needs: Schema.Array(Schema.String) },
});

export type DeclareLanePayload = Command.Payload<typeof DeclareLaneCommand>;
