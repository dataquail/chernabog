import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import { RunAlreadyActive } from "../domain/run/run.errors.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";
import { WorkItem } from "../domain/run/work-item.value-object.ts";

// Records a run starting, before its workflow does: a persona's run of a
// repo's flow on one work item, under a fresh id, with the @chernabog/core
// version it starts under and the .chernabog/ tree its flow was loaded from
// (none from a working copy). Fails when the persona already has a run in
// flight for the item, which is the one to follow.
export const StartRunCommand = Command.make("StartRunCommand", {
  payload: {
    id: RunId,
    coreVersion: Schema.String,
    configTree: Schema.optionalKey(Schema.Option(Schema.String)),
    repo: Schema.String,
    persona: Schema.Option(Schema.String),
    flow: Schema.String,
    itemKey: Schema.String,
    itemTitle: Schema.Option(Schema.String),
    itemUrl: Schema.Option(Schema.String),
    item: Schema.Option(WorkItem),
  },
  success: RunView,
  failure: RunAlreadyActive,
});

export type StartRunPayload = Command.Payload<typeof StartRunCommand>;
