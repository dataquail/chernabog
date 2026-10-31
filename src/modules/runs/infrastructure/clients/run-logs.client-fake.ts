import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunLogsClient } from "../../domain/ports/clients/run-logs.client.ts";

// Run logs in memory, by run id. Each read is of `logs` as it is then, so a
// test that adds to one is the engine writing it while the run goes on. Each
// was last written when `modified` says, in epoch millis, or else at the
// epoch; a pruned one reads as gone.
export const RunLogsClientFake = (
  logs: Record<string, string>,
  modified: Record<string, number> = {},
) => {
  const pruned = new Set<string>();
  const logOf = (runId: RunId) => Option.filter(Record.get(logs, runId), () => !pruned.has(runId));

  return Layer.succeed(
    RunLogsClient,
    RunLogsClient.of({
      ids: Effect.sync(() => Object.keys(logs).map((id) => RunId.make(id))),
      pathOf: (runId) => Effect.succeed(`/runs/${runId}.log`),
      readFrom: (runId, offset) =>
        Effect.sync(() => Option.map(logOf(runId), (text) => text.slice(offset))),
      modifiedAt: (runId) =>
        Effect.sync(() =>
          Option.as(
            logOf(runId),
            Option.getOrElse(Record.get(modified, runId), () => 0),
          ),
        ),
      prune: (runId) =>
        Effect.sync(() => {
          pruned.add(runId);
        }),
      pruned: (runId) => Effect.sync(() => pruned.has(runId)),
    }),
  );
};
