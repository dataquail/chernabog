import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunLogLines } from "../../../kernel/run-log-line.value-object.ts";
import { RunLogsClient } from "../domain/ports/clients/run-logs.client.ts";
import { type FollowRunLogPayload, RunLogGained } from "./follow-run-log.query.ts";

export const followRunLogHandler = Effect.fn("followRunLogHandler")(function* ({
  from,
  runId,
  step,
}: FollowRunLogPayload) {
  const logs = yield* RunLogsClient;

  // Which step a line is depends on the lines before it, so a step's lines
  // are read from the log's start.
  const only = Option.fromUndefinedOr(step);

  if (Option.isSome(only)) {
    const raw = Option.getOrElse(yield* logs.readFrom(runId, 0), () => "");

    return RunLogGained.make(
      RunLogLines.linesOfStep(
        raw,
        only.value.name,
        only.value.logs,
        from,
        Option.fromUndefinedOr(only.value.node),
      ),
    );
  }

  const gained = Option.getOrElse(yield* logs.readFrom(runId, from), () => "");

  return RunLogGained.make({
    text: Option.liftPredicate(RunLogLines.untagged(gained).trimEnd(), (text) => text.length > 0),
    next: from + gained.length,
  });
});
