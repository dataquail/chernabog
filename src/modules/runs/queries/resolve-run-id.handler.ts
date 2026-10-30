import * as Effect from "effect/Effect";

import { RunLogsClient } from "../domain/ports/clients/run-logs.client.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { NamedRun, type ResolveRunIdPayload } from "./resolve-run-id.query.ts";

export const resolveRunIdHandler = Effect.fn("resolveRunIdHandler")(function* ({
  asked,
}: ResolveRunIdPayload) {
  const ids = yield* (yield* RunLogsClient).ids;

  return NamedRun.make({ runId: yield* Effect.fromResult(RunRootOps.named(ids, asked)) });
});
