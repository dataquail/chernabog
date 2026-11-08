// GET /plans/:hash: a plan runs started with, by the hash a run's history
// names, which the dashboard draws the run on. Its plan is none when no run
// started with it.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { FlowPlan, FoundPlan } from "../../domain/plan/flow-plan.value-object.ts";
import { RunsQueries } from "../../runs.query-handlers.ts";

const PlanPath = Schema.Struct({ hash: Schema.String });

export const readFlowPlanEndpoint = Effect.gen(function* () {
  const { hash } = yield* HttpRouter.schemaPathParams(PlanPath);
  const found = yield* RunsQueries.use((runs) => runs.ReadFlowPlanQuery({ hash }));

  // A plan this binary kept is one it can read.
  const plan = yield* Effect.forEach(Option.toArray(found.plan), (kept) =>
    Schema.decodeUnknownEffect(FlowPlan)(kept).pipe(Effect.orDie),
  );

  return yield* HttpServerResponse.schemaJson(FoundPlan)(FoundPlan.make({ plan: Arr.head(plan) }));
});
