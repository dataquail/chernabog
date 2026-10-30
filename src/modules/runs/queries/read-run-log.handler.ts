import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunLogsClient } from "../domain/ports/clients/run-logs.client.ts";
import { RunLogMissing } from "../domain/run/run.errors.ts";
import { type ReadRunLogPayload, RunLog } from "./read-run-log.query.ts";

export const readRunLogHandler = Effect.fn("readRunLogHandler")(function* ({
  runId,
}: ReadRunLogPayload) {
  const logs = yield* RunLogsClient;
  const path = yield* logs.pathOf(runId);
  const text = yield* logs.readFrom(runId, 0);

  if (Option.isNone(text)) {
    return yield* new RunLogMissing({ runId, path });
  }

  return RunLog.make({ runId, path, text: text.value });
});
