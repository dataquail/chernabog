// GET /runs/:id: a run's row, or null when the daemon has none by that id. The
// CLI asks it while following a run the daemon started.

import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";

import { RunReply } from "../../../../interface/daemon/daemon.protocol.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunsQueries } from "../../runs.query-handlers.ts";

const RunPath = Schema.Struct({ id: RunId });

export const findRunEndpoint = Effect.gen(function* () {
  const { id } = yield* HttpRouter.schemaPathParams(RunPath);

  return yield* HttpServerResponse.schemaJson(RunReply)(
    (yield* RunsQueries.use((runs) => runs.FindRunQuery({ runId: id }))).run,
  );
});
