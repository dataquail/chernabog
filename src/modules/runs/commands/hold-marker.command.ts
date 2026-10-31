import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import { RunMarkerView } from "../domain/run-marker/run-marker-view.value-object.ts";

// Records that a run holds a marker, for its release when the run ends. A
// run holds a name and arguments once, so a run that resumes and holds it
// again changes nothing; one it let go is held again.
export const HoldMarkerCommand = Command.make("HoldMarkerCommand", {
  payload: {
    runId: RunId,
    name: Schema.String,
    args: Schema.Json,
    keepOn: Schema.Array(Schema.String),
  },
  success: RunMarkerView,
});

export type HoldMarkerPayload = Command.Payload<typeof HoldMarkerCommand>;
