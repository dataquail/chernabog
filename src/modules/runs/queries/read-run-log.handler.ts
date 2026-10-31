import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunLogsClient } from "../domain/ports/clients/run-logs.client.ts";
import { RunLogMissing, RunLogPruned } from "../domain/run/run.errors.ts";
import { RUN_LOG_RETENTION_DAYS } from "../domain/run/run-log-retention.value-object.ts";
import { type ReadRunLogPayload, RunLog } from "./read-run-log.query.ts";

export const readRunLogHandler = Effect.fn("readRunLogHandler")(function* ({
  runId,
}: ReadRunLogPayload) {
  const logs = yield* RunLogsClient;
  const path = yield* logs.pathOf(runId);
  const text = yield* logs.readFrom(runId, 0);

  if (Option.isSome(text)) {
    return RunLog.make({ runId, path, text: text.value });
  }

  if (yield* logs.pruned(runId)) {
    return yield* new RunLogPruned({ runId, days: RUN_LOG_RETENTION_DAYS });
  }

  return yield* new RunLogMissing({ runId, path });
});
