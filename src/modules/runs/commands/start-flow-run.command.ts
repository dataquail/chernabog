import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { StartedRun } from "../domain/run/run-view.value-object.ts";
import { WorkItem } from "../domain/run/work-item.value-object.ts";

// Starts one run of a persona's flow for one work item, and its workflow,
// unless the persona already has one in flight for it: then that one is the
// run. An item reported only to wake a run, or held, starts none.
export const StartFlowRunCommand = Command.make("StartFlowRunCommand", {
  payload: {
    flow: Schema.Struct({
      repo: Schema.String,
      flow: Schema.String,
      persona: Schema.Option(Schema.String),
    }),
    item: WorkItem,
  },
  success: StartedRun,
});

export type StartFlowRunPayload = Command.Payload<typeof StartFlowRunCommand>;
