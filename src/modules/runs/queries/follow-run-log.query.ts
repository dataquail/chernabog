import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import { StepLogs } from "../../../kernel/run-log-line.value-object.ts";

// What a followed log gained since the offset it was last read to: the
// piece to show, without its trailing newline (none when it gained nothing
// but whitespace), and the offset to read from next.
export class RunLogGained extends Schema.Class<RunLogGained, { readonly brand: "RunLogGained" }>(
  "RunLogGained",
)({
  text: Schema.Option(Schema.String),
  next: Schema.Int,
}) {}

// One step's lines alone: the step by its full name, and how the run's log
// splits by step, as its history says (RunHistory's stepLogs).
export const LogOfStep = Schema.Struct({ name: Schema.String, logs: StepLogs });

// One read of a run's log as a follower makes it: what the log gained from
// `from` on, nothing for a run that has written none yet, as a person reads
// it (without the steps its lines are tagged with). With `step`, only that
// step's lines, read a whole line at a time. Reading again on a schedule,
// and stopping once the run has finished, is the follower's, since only it
// knows who to ask (the CLI asks the daemon).
export const FollowRunLogQuery = Query.make("FollowRunLogQuery", {
  payload: { runId: RunId, from: Schema.Int, step: Schema.optionalKey(LogOfStep) },
  success: RunLogGained,
});

export type FollowRunLogPayload = Query.Payload<typeof FollowRunLogQuery>;
