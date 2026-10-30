// Runs in om_runs, in state.db next to the workflow journal. The workflow
// engine owns its own tables; this one is chernabog's. Only the daemon's
// process (or a foreground `chernabog run`, which holds the same lock) writes it.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { type RunId } from "../../../../kernel/run-id.id.ts";
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

    // One from before core records the all-in-one @chernabog/sdk its runs
    // started under as their core: a version no core-providing binary resumes,
    // so those runs go to a person. One from before that gains a column of
    // versions nothing resumes either.
    if (!columns.some((column) => column.name === "core_version")) {
      if (columns.some((column) => column.name === "sdk_version")) {
        yield* sql`ALTER TABLE om_runs RENAME COLUMN sdk_version TO core_version`;
      } else {
        yield* sql`ALTER TABLE om_runs ADD COLUMN core_version TEXT`;
        yield* sql`UPDATE om_runs SET core_version = '0.0.0' WHERE core_version IS NULL`;
      }
    }

    // One from before runs kept their .chernabog/ tree gains it; its rows have none.
    if (!columns.some((column) => column.name === "config_tree")) {
      yield* sql`ALTER TABLE om_runs ADD COLUMN config_tree TEXT`;
    }

    // What each run named as its subjects, in the order it named them.
    yield* sql`CREATE TABLE IF NOT EXISTS om_run_subjects (
      run_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      PRIMARY KEY (run_id, subject)
    )`;

    // One from when runs kept the pull request they opened names it as the
    // run's subject, and drops the column: the engine keeps no pull request.
    if (columns.some((column) => column.name === "pull_request")) {
      yield* sql`INSERT OR IGNORE INTO om_run_subjects (run_id, subject)
        SELECT id, 'pr-' || pull_request FROM om_runs WHERE pull_request IS NOT NULL`;
      yield* sql`ALTER TABLE om_runs DROP COLUMN pull_request`;
    }

    yield* sql`DROP INDEX IF EXISTS om_runs_active`;
    yield* sql`CREATE INDEX IF NOT EXISTS om_runs_active_by_persona ON om_runs (status, repo, persona, flow, item_key)`;

    // Queries this adapter wrote against its own table: a failure is a bug, not a condition.
    // Every column of om_runs, and the run's subjects as a JSON array.
    const SELECTED = sql`SELECT om_runs.*, (
      SELECT json_group_array(subject) FROM (
        SELECT subject FROM om_run_subjects WHERE run_id = om_runs.id ORDER BY rowid
      )
    ) AS subjects FROM om_runs`;

    const runs = <E>(query: Effect.Effect<ReadonlyArray<object>, E>) =>
      query.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RunColumns))),
        Effect.map((rows) => rows.map(toRoot)),
        Effect.orDie,
      );

    const findOne = (id: RunId) =>
      runs(sql`${SELECTED} WHERE id = ${id}`).pipe(
        Effect.map((found) => Option.fromUndefinedOr(found[0])),
      );

    const findAll = (query: RunsQuery) => {
      if ("running" in query) {
        return runs(sql`${SELECTED} WHERE status = 'running' ORDER BY started_at`);
      }

      if ("latest" in query) {
        return runs(sql`${SELECTED} ORDER BY started_at DESC LIMIT ${query.latest}`);
      }

      return runs(sql`${SELECTED} WHERE repo = ${query.repo} ORDER BY started_at`);
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
        subjects,
        status,
        currentStep,
        summary,
        coreVersion,
        configTree,
        startedAt,
        finishedAt,
      ] = toParameters(run);

      return sql`INSERT INTO om_runs (id, repo, persona, flow, item_key, item_title, item_url, item, execution_id, status, current_step, summary, core_version, config_tree, started_at, finished_at)
        VALUES (${id}, ${repo}, ${persona}, ${flow}, ${itemKey}, ${itemTitle}, ${itemUrl}, ${item}, ${executionId}, ${status}, ${currentStep}, ${summary}, ${coreVersion}, ${configTree}, ${startedAt}, ${finishedAt})
        ON CONFLICT (id) DO UPDATE SET
          persona = excluded.persona,
          execution_id = excluded.execution_id,
          status = excluded.status,
          current_step = excluded.current_step,
          summary = excluded.summary,
          finished_at = excluded.finished_at
        WHERE om_runs.finished_at IS NULL OR om_runs.finished_at = excluded.finished_at`.pipe(
        // Subjects only grow, so a stale copy that names fewer drops none.
        Effect.andThen(
          Effect.forEach(
            subjects,
            (subject) =>
              sql`INSERT OR IGNORE INTO om_run_subjects (run_id, subject) VALUES (${id}, ${subject})`,
            { discard: true },
          ),
        ),
        Effect.asVoid,
        Effect.orDie,
      );
    };

    return RunsRepository.of({ findOne, findAll, save });
  }).pipe(Effect.orDie),
);
