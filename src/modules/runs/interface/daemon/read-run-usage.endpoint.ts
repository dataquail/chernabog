// GET /runs/:id/usage: what a run's agent calls spent, by model and by step,
// and its compute time, which the dashboard's page of a run shows. Encoded
// with the protocol's shape of it, since the query owns its read model.

import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";

import { RunUsage } from "../../../../interface/daemon/daemon.protocol.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunsQueries } from "../../runs.query-handlers.ts";

const RunPath = Schema.Struct({ id: RunId });

export const readRunUsageEndpoint = Effect.gen(function* () {
  const { id } = yield* HttpRouter.schemaPathParams(RunPath);

  return yield* HttpServerResponse.schemaJson(RunUsage)(
    yield* RunsQueries.use((runs) => runs.ReadRunUsageQuery({ runId: id })),
  );
});
