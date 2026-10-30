import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { SkipView } from "../domain/skip/skip-view.value-object.ts";

// Records why a tick of a persona's flow started nothing, for `status` to show.
export const RecordSkipCommand = Command.make("RecordSkipCommand", {
  payload: {
    repo: Schema.String,
    persona: Schema.Option(Schema.String),
    flow: Schema.String,
    itemKey: Schema.Option(Schema.String),
    reason: Schema.String,
  },
  success: SkipView,
});

export type RecordSkipPayload = Command.Payload<typeof RecordSkipCommand>;
