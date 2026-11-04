// Lanes in om_lanes, in state.db beside the runs that declared them. A run
// that declared none, as any from before lanes, has none.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { type Specification } from "../../../../kernel/specification.ts";
import { type RunLaneEntity } from "../../domain/run/run-lane.entity.ts";
import { RunLanesRepository } from "../../domain/run/run-lanes.repository.ts";
import { criteriaToWhere } from "./criteria-to-sql.ts";
import { LaneColumns, laneColumns, needsColumn, toEntity } from "./run-lane.mapper.ts";

export const RunLanesRepositoryLive = Layer.effect(
  RunLanesRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE IF NOT EXISTS om_lanes (
      run_id TEXT NOT NULL,
      lane TEXT NOT NULL,
      needs TEXT NOT NULL,
      PRIMARY KEY (run_id, lane)
    )`;

    // Queries this adapter wrote against its own table: a failure is a bug, not a condition.
    // A lane keeps its row, and so its rowid, when its needs change.
    const findMany = (spec: Specification<RunLaneEntity>) =>
      criteriaToWhere(sql, spec.criteria, laneColumns).pipe(
        Effect.flatMap((where) => sql`SELECT * FROM om_lanes WHERE ${where} ORDER BY rowid`),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LaneColumns))),
        Effect.map((rows) => rows.map(toEntity)),
        Effect.orDie,
      );

    const upsertOne = (lane: RunLaneEntity) =>
      sql`INSERT INTO om_lanes (run_id, lane, needs) VALUES (${lane.runId}, ${lane.lane}, ${needsColumn(lane)})
        ON CONFLICT (run_id, lane) DO UPDATE SET needs = excluded.needs`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );

    return RunLanesRepository.of({ findMany, upsertOne });
  }).pipe(Effect.orDie),
);
