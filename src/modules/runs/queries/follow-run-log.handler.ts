import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunLogsClient } from "../domain/ports/clients/run-logs.client.ts";
import { type FollowRunLogPayload, RunLogGained } from "./follow-run-log.query.ts";

export const followRunLogHandler = Effect.fn("followRunLogHandler")(function* ({
  from,
  runId,
}: FollowRunLogPayload) {
  const gained = Option.getOrElse(yield* (yield* RunLogsClient).readFrom(runId, from), () => "");

  return RunLogGained.make({
    text: Option.liftPredicate(gained.trimEnd(), (text) => text.length > 0),
    next: from + gained.length,
  });
});
