import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { StartedRun } from "../domain/run/run-view.value-object.ts";
import { WorkItem } from "../domain/run/work-item.value-object.ts";

// Records one run of a persona's flow for one work item, for a spoke to
// execute (ADR 23, decision 2): the run, with the item it is for, and the
// execution its spoke's workflow runs under, which is keyed by the run. It
// executes nothing: the hub that dispatches it spawns the spoke. A persona
// with a run in flight for the item already has its run, and an item
// reported only to wake a run, or held, starts none.
export const StartSpokeRunCommand = Command.make("StartSpokeRunCommand", {
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

export type StartSpokeRunPayload = Command.Payload<typeof StartSpokeRunCommand>;
