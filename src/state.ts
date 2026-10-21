// Runs and the waits they are suspended on, in state.db next to the workflow
// journal. The workflow engine owns its own tables; these are Chernabog's.

import * as Context from 'effect/Context';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as SqlClient from 'effect/sql/SqlClient';

import type { Persona } from './persona.ts';

export const RunStatus = Schema.Literals(['running', 'done', 'skipped', 'needs-human', 'failed']);

export type RunStatus = typeof RunStatus.Type;

const Maybe = Schema.OptionFromNullOr(Schema.String);

// A run, as the CLI and TUI see it; absent values cross the socket as null.
export const RunRow = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  // The GitHub persona it acts as; null for the implicit one.
  persona: Maybe,
  flow: Schema.String,
  itemKey: Schema.String,
  itemTitle: Maybe,
  itemUrl: Maybe,
  executionId: Maybe,
  status: RunStatus,
  currentStep: Maybe,
  summary: Maybe,
  startedAt: Schema.String,
  finishedAt: Maybe,
});

export type RunRow = typeof RunRow.Type;

export const WaitRow = Schema.Struct({ runId: Schema.String, signal: Schema.String, deferred: Schema.String, token: Schema.String });

export type WaitRow = typeof WaitRow.Type;

export const SkipRow = Schema.Struct({ repo: Schema.String, persona: Maybe, flow: Schema.String, itemKey: Maybe, reason: Schema.String, at: Schema.String });

export type SkipRow = typeof SkipRow.Type;

// The tables' own columns.
const RunColumns = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  persona: Maybe,
  flow: Schema.String,
  item_key: Schema.String,
  item_title: Maybe,
  item_url: Maybe,
  execution_id: Maybe,
  status: RunStatus,
  current_step: Maybe,
  summary: Maybe,
  started_at: Schema.String,
  finished_at: Maybe,
});

const WaitColumns = Schema.Struct({ run_id: Schema.String, signal: Schema.String, deferred: Schema.String, token: Schema.String });

const SkipColumns = Schema.Struct({ repo: Schema.String, persona: Maybe, flow: Schema.String, item_key: Maybe, reason: Schema.String, at: Schema.String });

const ColumnName = Schema.Struct({ name: Schema.String });

const RunIdColumn = Schema.Struct({ run_id: Schema.String });

const toRun = (row: typeof RunColumns.Type): RunRow => ({
  id: row.id,
  repo: row.repo,
  persona: row.persona,
  flow: row.flow,
  itemKey: row.item_key,
  itemTitle: row.item_title,
  itemUrl: row.item_url,
  executionId: row.execution_id,
  status: row.status,
  currentStep: row.current_step,
  summary: row.summary,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

export type NewRun = {
  readonly id: string;
  readonly repo: string;
  readonly persona: Persona;
  readonly flow: string;
  readonly itemKey: string;
  readonly itemTitle: Option.Option<string>;
  readonly itemUrl: Option.Option<string>;
};

export type NewSkip = { readonly repo: string; readonly persona: Persona; readonly flow: string; readonly itemKey: Option.Option<string>; readonly reason: string };

export type RunFilter = { readonly repo: Option.Option<string>; readonly persona: Option.Option<Persona>; readonly flow: Option.Option<string> };

export const everyRun: RunFilter = { repo: Option.none(), persona: Option.none(), flow: Option.none() };

const matches = (filter: Option.Option<string>, value: string) => Option.match(filter, { onNone: () => true, onSome: (wanted) => wanted === value });

const matchesPersona = (filter: Option.Option<Persona>, value: Persona) => Option.match(filter, { onNone: () => true, onSome: (wanted) => Option.getOrNull(wanted) === Option.getOrNull(value) });

export class State extends Context.Service<
  State,
  {
    insertRun(run: NewRun): Effect.Effect<void>;
    setExecution(runId: string, executionId: string): Effect.Effect<void>;
    setStep(runId: string, step: string): Effect.Effect<void>;
    finishRun(runId: string, status: RunStatus, summary: string): Effect.Effect<void>;
    run(runId: string): Effect.Effect<Option.Option<RunRow>>;
    activeRuns(filter: RunFilter): Effect.Effect<ReadonlyArray<RunRow>>;
    activeRunFor(repo: string, persona: Persona, flow: string, itemKey: string): Effect.Effect<Option.Option<RunRow>>;
    // Gives the repo's runs and skips from before personas a persona, so they resume as it.
    adoptRuns(repo: string, login: string): Effect.Effect<void>;
    recentRuns(limit: number): Effect.Effect<ReadonlyArray<RunRow>>;
    addWait(wait: WaitRow): Effect.Effect<void>;
    waitsFor(runId: string, signal: string): Effect.Effect<ReadonlyArray<WaitRow>>;
    removeWait(runId: string, deferred: string): Effect.Effect<void>;
    // Runs waiting on a signal, such as a review waiting for its author's push. They hold no slot.
    readonly parkedRunIds: Effect.Effect<ReadonlyArray<string>>;
    recordSkip(skip: NewSkip): Effect.Effect<void>;
    recentSkips(limit: number): Effect.Effect<ReadonlyArray<SkipRow>>;
  }
>()('chernabog/State') {
  public static readonly layer: Layer.Layer<State, never, SqlClient.SqlClient> = Layer.effect(
    State,
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
      yield* sql`CREATE TABLE IF NOT EXISTS om_waits (
        run_id TEXT NOT NULL,
        signal TEXT NOT NULL,
        deferred TEXT NOT NULL,
        token TEXT NOT NULL,
        PRIMARY KEY (run_id, deferred)
      )`;
      yield* sql`CREATE TABLE IF NOT EXISTS om_skips (
        repo TEXT NOT NULL,
        flow TEXT NOT NULL,
        item_key TEXT,
        reason TEXT NOT NULL,
        at TEXT NOT NULL
      )`;

      // Databases from before personas gain the column; their rows read as the implicit persona.
      for (const table of ['om_runs', 'om_skips']) {
        const columns = yield* sql`SELECT name FROM pragma_table_info(${table})`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ColumnName))));

        if (!columns.some((column) => column.name === 'persona')) yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN persona TEXT`);
      }

      yield* sql`DROP INDEX IF EXISTS om_runs_active`;
      yield* sql`CREATE INDEX IF NOT EXISTS om_runs_active_by_persona ON om_runs (status, repo, persona, flow, item_key)`;

      const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const nullable = (value: Option.Option<string>) => Option.getOrNull(value);
      // Queries this module wrote against its own tables: a failure is a bug, not a condition to handle.
      const write = <A, E>(query: Effect.Effect<A, E>) => Effect.orDie(query).pipe(Effect.asVoid);

      const rows =
        <A, I>(columns: Schema.Codec<A, I>) =>
        <E>(query: Effect.Effect<ReadonlyArray<object>, E>) =>
          query.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(columns))), Effect.orDie);

      const runs = rows(RunColumns);

      return State.of({
        insertRun: (run) =>
          Effect.flatMap(now, (at) =>
            write(sql`INSERT INTO om_runs (id, repo, persona, flow, item_key, item_title, item_url, status, started_at)
              VALUES (${run.id}, ${run.repo}, ${nullable(run.persona)}, ${run.flow}, ${run.itemKey}, ${nullable(run.itemTitle)}, ${nullable(run.itemUrl)}, 'running', ${at})`),
          ),
        setExecution: (runId, executionId) => write(sql`UPDATE om_runs SET execution_id = ${executionId} WHERE id = ${runId}`),
        setStep: (runId, step) => write(sql`UPDATE om_runs SET current_step = ${step} WHERE id = ${runId}`),
        finishRun: (runId, status, summary) =>
          Effect.flatMap(now, (at) => write(sql`UPDATE om_runs SET status = ${status}, summary = ${summary}, finished_at = ${at}, current_step = NULL WHERE id = ${runId}`)),
        run: (runId) => runs(sql`SELECT * FROM om_runs WHERE id = ${runId}`).pipe(Effect.map((found) => Option.map(Option.fromUndefinedOr(found[0]), toRun))),
        activeRuns: (filter) =>
          runs(sql`SELECT * FROM om_runs WHERE status = 'running' ORDER BY started_at`).pipe(
            Effect.map((found) => found.map(toRun).filter((run) => matches(filter.repo, run.repo) && matchesPersona(filter.persona, run.persona) && matches(filter.flow, run.flow))),
          ),
        // IS, unlike =, matches the implicit persona's NULL.
        activeRunFor: (repo, persona, flow, itemKey) =>
          runs(sql`SELECT * FROM om_runs WHERE status = 'running' AND repo = ${repo} AND persona IS ${nullable(persona)} AND flow = ${flow} AND item_key = ${itemKey}`).pipe(
            Effect.map((found) => Option.map(Option.fromUndefinedOr(found[0]), toRun)),
          ),
        adoptRuns: (repo, login) =>
          Effect.andThen(
            write(sql`UPDATE om_runs SET persona = ${login} WHERE repo = ${repo} AND persona IS NULL`),
            write(sql`UPDATE om_skips SET persona = ${login} WHERE repo = ${repo} AND persona IS NULL`),
          ),
        recentRuns: (limit) => runs(sql`SELECT * FROM om_runs ORDER BY started_at DESC LIMIT ${limit}`).pipe(Effect.map((found) => found.map(toRun))),
        addWait: (wait) => write(sql`INSERT OR REPLACE INTO om_waits (run_id, signal, deferred, token) VALUES (${wait.runId}, ${wait.signal}, ${wait.deferred}, ${wait.token})`),
        waitsFor: (runId, signal) =>
          rows(WaitColumns)(sql`SELECT * FROM om_waits WHERE run_id = ${runId} AND signal = ${signal}`).pipe(
            Effect.map((found) => found.map((row) => ({ runId: row.run_id, signal: row.signal, deferred: row.deferred, token: row.token }))),
          ),
        removeWait: (runId, deferred) => write(sql`DELETE FROM om_waits WHERE run_id = ${runId} AND deferred = ${deferred}`),
        parkedRunIds: rows(RunIdColumn)(sql`SELECT DISTINCT run_id FROM om_waits`).pipe(Effect.map((found) => found.map((row) => row.run_id))),
        recordSkip: (skip) =>
          Effect.flatMap(now, (at) =>
            write(sql`INSERT INTO om_skips (repo, persona, flow, item_key, reason, at) VALUES (${skip.repo}, ${nullable(skip.persona)}, ${skip.flow}, ${nullable(skip.itemKey)}, ${skip.reason}, ${at})`),
          ),
        recentSkips: (limit) =>
          rows(SkipColumns)(sql`SELECT * FROM om_skips ORDER BY at DESC LIMIT ${limit}`).pipe(
            Effect.map((found) => found.map((row) => ({ repo: row.repo, persona: row.persona, flow: row.flow, itemKey: row.item_key, reason: row.reason, at: row.at }))),
          ),
      });
    }).pipe(Effect.orDie),
  );
}
