// GET /runs/:id/history: what a run went through, step by step, which the TUI
// shows for the run a person picks.

import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunHistory } from "../../domain/run/run-history.value-object.ts";
import { RunsQueries } from "../../runs.query-handlers.ts";

const RunPath = Schema.Struct({ id: RunId });

export const readRunHistoryEndpoint = Effect.gen(function* () {
  const { id } = yield* HttpRouter.schemaPathParams(RunPath);

  return yield* HttpServerResponse.schemaJson(RunHistory)(
    yield* RunsQueries.use((runs) => runs.ReadRunHistoryQuery({ runId: id })),
  );
});
