import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";

// Forgets a hold a run let go of itself (Markers.drop), so nothing releases
// it when the run ends. Forgetting one it doesn't hold changes nothing.
export const ForgetMarkerCommand = Command.make("ForgetMarkerCommand", {
  payload: { runId: RunId, name: Schema.String, args: Schema.Json },
});

export type ForgetMarkerPayload = Command.Payload<typeof ForgetMarkerCommand>;
