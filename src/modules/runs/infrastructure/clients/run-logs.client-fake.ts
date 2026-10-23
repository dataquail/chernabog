import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunLogsClient } from "../../domain/ports/clients/run-logs.client.ts";

// Run logs in memory, by run id. Each read is of `logs` as it is then, so a
// test that adds to one is the engine writing it while the run goes on.
export const RunLogsClientFake = (logs: Record<string, string>) =>
  Layer.succeed(
    RunLogsClient,
    RunLogsClient.of({
      ids: Effect.sync(() => Object.keys(logs).map((id) => RunId.make(id))),
      pathOf: (runId) => Effect.succeed(`/runs/${runId}.log`),
      readFrom: (runId, offset) =>
        Effect.sync(() => Option.map(Record.get(logs, runId), (text) => text.slice(offset))),
    }),
  );
