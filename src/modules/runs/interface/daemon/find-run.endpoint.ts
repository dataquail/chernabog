// GET /runs/:id: a run's row, or null when the daemon has none by that id. The
// CLI asks it while following a run the daemon started, and the dashboard's
// page of a run, which may name it by a unique prefix of its id, as `logs`
// takes it: among the runs with a log, else the id as asked. A prefix that
// names several runs is refused.

import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";

import { Refusal, RunReply } from "../../../../interface/daemon/daemon.protocol.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunLogsQueries, RunsQueries } from "../../runs.query-handlers.ts";

const AskedPath = Schema.Struct({ id: Schema.String });

export const findRunEndpoint = Effect.gen(function* () {
  const { id } = yield* HttpRouter.schemaPathParams(AskedPath);

  // A run that has written no log yet is found by its whole id.
  const runId = yield* RunLogsQueries.use((logs) => logs.ResolveRunIdQuery({ asked: id })).pipe(
    Effect.map((named) => named.runId),
    Effect.catchTag("RunNotNamed", () => Effect.succeed(RunId.make(id))),
  );

  return yield* HttpServerResponse.schemaJson(RunReply)(
    (yield* RunsQueries.use((runs) => runs.FindRunQuery({ runId }))).run,
  );
}).pipe(
  Effect.catchTag("AmbiguousRunPrefix", (ambiguous) =>
    HttpServerResponse.schemaJson(Refusal)({ error: ambiguous.message }, { status: 409 }),
  ),
);
