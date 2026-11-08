// The marks runs left at the nodes of their plans, in om_nodes, in state.db
// beside the runs that left them. A run of a flow with no plan has none.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { type Specification } from "../../../../kernel/specification.ts";
import { type RunNodeEntity } from "../../domain/run/run-node.entity.ts";
import { RunNodesRepository } from "../../domain/run/run-nodes.repository.ts";
import { criteriaToWhere } from "./criteria-to-sql.ts";
import { NodeColumns, nodeColumns, toEntity } from "./run-node.mapper.ts";

export const RunNodesRepositoryLive = Layer.effect(
  RunNodesRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE IF NOT EXISTS om_nodes (
      run_id TEXT NOT NULL,
      mark TEXT NOT NULL,
      node TEXT NOT NULL,
      node_round INTEGER,
      node_lane TEXT,
      at TEXT NOT NULL,
      finished_at TEXT,
      outcome TEXT
    )`;
    yield* sql`CREATE INDEX IF NOT EXISTS om_nodes_by_run ON om_nodes (run_id)`;

    // Queries this adapter wrote against its own table: a failure is a bug, not a condition.
    // Rows are added in the order a run makes them, so rowid breaks a tie in time.
    const findMany = (spec: Specification<RunNodeEntity>) =>
      criteriaToWhere(sql, spec.criteria, nodeColumns).pipe(
        Effect.flatMap((where) => sql`SELECT * FROM om_nodes WHERE ${where} ORDER BY at, rowid`),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(NodeColumns))),
        Effect.map((rows) => rows.map(toEntity)),
        Effect.orDie,
      );

    const insertOne = (mark: RunNodeEntity) =>
      sql`INSERT INTO om_nodes (run_id, mark, node, node_round, node_lane, at, finished_at, outcome) VALUES (${mark.runId}, ${mark.mark}, ${mark.node}, ${Option.getOrNull(mark.round)}, ${Option.getOrNull(mark.lane)}, ${mark.at}, ${Option.getOrNull(mark.finishedAt)}, ${Option.getOrNull(mark.outcome)})`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );

    // A mark is the run's one of its kind at a node in a round and a lane.
    const updateOne = (mark: RunNodeEntity) =>
      sql`UPDATE om_nodes SET finished_at = ${Option.getOrNull(mark.finishedAt)}, outcome = ${Option.getOrNull(mark.outcome)} WHERE run_id = ${mark.runId} AND mark = ${mark.mark} AND node = ${mark.node} AND node_round IS ${Option.getOrNull(mark.round)} AND node_lane IS ${Option.getOrNull(mark.lane)}`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );

    return RunNodesRepository.of({ findMany, insertOne, updateOne });
  }).pipe(Effect.orDie),
);
