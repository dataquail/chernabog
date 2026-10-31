import * as Effect from "effect/Effect";

import { PrunedRunLogs } from "./prune-run-logs.command.ts";

export const pruneRunLogsHandler = Effect.fn("pruneRunLogsHandler")(function* () {
  yield* Effect.void;

  return PrunedRunLogs.make({ removed: [] });
});
