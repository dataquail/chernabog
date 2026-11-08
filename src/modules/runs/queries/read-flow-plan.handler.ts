import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { PlanRow } from "../storage/plan.schema.ts";
import { PlanView, type ReadFlowPlanPayload } from "./read-flow-plan.query.ts";

export const readFlowPlanHandler = Effect.fn("readFlowPlanHandler")(function* ({
  hash,
}: ReadFlowPlanPayload) {
  const sql = yield* SqlClient.SqlClient;

  // A query over the runs' own table: a failure is a bug, not a condition.
  const rows = yield* sql`SELECT hash, plan FROM om_plans WHERE hash = ${hash}`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PlanRow))),
    Effect.orDie,
  );

  return PlanView.make({ plan: Option.map(Arr.head(rows), (row) => row.plan) });
});
