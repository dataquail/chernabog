import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { RunLogsClient } from "../domain/ports/clients/run-logs.client.ts";
import { RunLogMissing } from "../domain/run/run.errors.ts";
import { RunLog } from "./run-log.result.ts";

// A run's log as it is now. Fails when the run has written none.
export const readRunLogUseCase = Effect.fn("readRunLogUseCase")(function* (runId: RunId) {
  const logs = yield* RunLogsClient;
  const path = yield* logs.pathOf(runId);
  const text = yield* logs.readFrom(runId, 0);

  if (Option.isNone(text)) {
    return yield* new RunLogMissing({ runId, path });
  }

  return RunLog.make({ runId, path, text: text.value });
});
