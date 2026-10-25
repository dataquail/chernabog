// Runs in om_runs, in state.db next to the workflow journal. The workflow
// engine owns its own tables; this one is chernabog's. Only the daemon's
// process (or a foreground `chernabog run`, which holds the same lock) writes it.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { type RunId } from "../../../../kernel/run-id.id.ts";
import { BUNDLED_SDK } from "../../../../platform/flow-deps.ts";
import { type RunsQuery, RunsRepository } from "../../domain/ports/repositories/runs.repository.ts";
import { type RunRoot } from "../../domain/run/run.root.ts";
import { RunColumns, toParameters, toRoot } from "./run.mapper.ts";

const ColumnName = Schema.Struct({ name: Schema.String });

export const RunsRepositoryLive = Layer.effect(
  RunsRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE IF NOT EXISTS om_runs (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      flow TEXT NOT NULL,
      item_key TEXT NOT NULL,
      item_title TEXT,
      item_url TEXT,
      execution_id TEXT,
      status TEXT NOT NULL,
      current_step TEXT,
      summary TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    )`;

    // A database from before personas gains the column; its rows read as the implicit persona.
    const columns = yield* sql`SELECT name FROM pragma_table_info('om_runs')`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ColumnName))),
    );

    if (!columns.some((column) => column.name === "persona")) {
      yield* sql`ALTER TABLE om_runs ADD COLUMN persona TEXT`;
    }

    // One from before runs kept their work item gains it; its rows have none.
    if (!columns.some((column) => column.name === "item")) {
      yield* sql`ALTER TABLE om_runs ADD COLUMN item TEXT`;
    }

    // One from before runs kept their SDK gains it. Its runs in flight started
    // under the SDK this binary bundles or one compatible with it: before
    // stamps, nothing ever ran an incompatible one.
    if (!columns.some((column) => column.name === "sdk_version")) {
      yield* sql`ALTER TABLE om_runs ADD COLUMN sdk_version TEXT`;
      yield* sql`UPDATE om_runs SET sdk_version = ${BUNDLED_SDK} WHERE sdk_version IS NULL`;
    }

    // One from before runs kept the pull request they opened gains it; its rows have none.
    if (!columns.some((column) => column.name === "pull_request")) {
      yield* sql`ALTER TABLE om_runs ADD COLUMN pull_request INTEGER`;
    }

    yield* sql`DROP INDEX IF EXISTS om_runs_active`;
    yield* sql`CREATE INDEX IF NOT EXISTS om_runs_active_by_persona ON om_runs (status, repo, persona, flow, item_key)`;

    // Queries this adapter wrote against its own table: a failure is a bug, not a condition.
    const runs = <E>(query: Effect.Effect<ReadonlyArray<object>, E>) =>
      query.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RunColumns))),
        Effect.map((rows) => rows.map(toRoot)),
        Effect.orDie,
      );

    const findOne = (id: RunId) =>
      runs(sql`SELECT * FROM om_runs WHERE id = ${id}`).pipe(
        Effect.map((found) => Option.fromUndefinedOr(found[0])),
      );

    const findAll = (query: RunsQuery) => {
      if ("running" in query) {
        return runs(sql`SELECT * FROM om_runs WHERE status = 'running' ORDER BY started_at`);
      }

      if ("latest" in query) {
        return runs(sql`SELECT * FROM om_runs ORDER BY started_at DESC LIMIT ${query.latest}`);
      }

      return runs(sql`SELECT * FROM om_runs WHERE repo = ${query.repo} ORDER BY started_at`);
    };

    // A run that has ended is rewritten only by a save that carries the same
    // ending, so a stale copy saved after it ended can't bring it back.
    const save = (run: RunRoot) => {
      const [
        id,
        repo,
        persona,
        flow,
        itemKey,
        itemTitle,
        itemUrl,
        item,
        executionId,
        pullRequest,
        status,
        currentStep,
        summary,
        sdkVersion,
        startedAt,
        finishedAt,
      ] = toParameters(run);

      return sql`INSERT INTO om_runs (id, repo, persona, flow, item_key, item_title, item_url, item, execution_id, pull_request, status, current_step, summary, sdk_version, started_at, finished_at)
        VALUES (${id}, ${repo}, ${persona}, ${flow}, ${itemKey}, ${itemTitle}, ${itemUrl}, ${item}, ${executionId}, ${pullRequest}, ${status}, ${currentStep}, ${summary}, ${sdkVersion}, ${startedAt}, ${finishedAt})
        ON CONFLICT (id) DO UPDATE SET
          persona = excluded.persona,
          execution_id = excluded.execution_id,
          pull_request = excluded.pull_request,
          status = excluded.status,
          current_step = excluded.current_step,
          summary = excluded.summary,
          finished_at = excluded.finished_at
        WHERE om_runs.finished_at IS NULL OR om_runs.finished_at = excluded.finished_at`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );
    };

    return RunsRepository.of({ findOne, findAll, save });
  }).pipe(Effect.orDie),
);
