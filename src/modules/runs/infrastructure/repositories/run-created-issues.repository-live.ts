// The issues runs created, in om_created_issues, in state.db beside the runs
// that created them. A run that created none, as any from before they were
// kept, has none.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { type Specification } from "../../../../kernel/specification.ts";
import { type RunCreatedIssueEntity } from "../../domain/run/run-created-issue.entity.ts";
import { RunCreatedIssuesRepository } from "../../domain/run/run-created-issues.repository.ts";
import { criteriaToWhere } from "./criteria-to-sql.ts";
import { CreatedIssueColumns, createdIssueColumns, toEntity } from "./run-created-issue.mapper.ts";

export const RunCreatedIssuesRepositoryLive = Layer.effect(
  RunCreatedIssuesRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE IF NOT EXISTS om_created_issues (
      run_id TEXT NOT NULL,
      issue INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, issue)
    )`;

    // Queries this adapter wrote against its own table: a failure is a bug, not a condition.
    const findMany = (spec: Specification<RunCreatedIssueEntity>) =>
      criteriaToWhere(sql, spec.criteria, createdIssueColumns).pipe(
        Effect.flatMap(
          (where) => sql`SELECT * FROM om_created_issues WHERE ${where} ORDER BY rowid`,
        ),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(CreatedIssueColumns))),
        Effect.map((rows) => rows.map(toEntity)),
        Effect.orDie,
      );

    // An issue already recorded keeps when it was first.
    const insertOne = (created: RunCreatedIssueEntity) =>
      sql`INSERT INTO om_created_issues (run_id, issue, created_at)
        VALUES (${created.runId}, ${created.issue}, ${created.createdAt})
        ON CONFLICT (run_id, issue) DO NOTHING`.pipe(Effect.asVoid, Effect.orDie);

    return RunCreatedIssuesRepository.of({ findMany, insertOne });
  }).pipe(Effect.orDie),
);
