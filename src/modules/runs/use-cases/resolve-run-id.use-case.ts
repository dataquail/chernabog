import * as Effect from "effect/Effect";

import { RunLogsClient } from "../domain/ports/clients/run-logs.client.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { NamedRun } from "./run-log.result.ts";

// The run a person names by enough of its id, among the runs with a log, as
// `logs` and `attach` take it.
export const resolveRunIdUseCase = Effect.fn("resolveRunIdUseCase")(function* (asked: string) {
  const ids = yield* (yield* RunLogsClient).ids;

  return NamedRun.make({ runId: yield* Effect.fromResult(RunRootOps.named(ids, asked)) });
});
