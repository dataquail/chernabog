import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { effect } from "../../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../../test/sqlite.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunsRepository } from "../../domain/ports/repositories/runs.repository.ts";
import { RunRoot } from "../../domain/run/run.root.ts";
import { RunsRepositoryLive } from "./runs.repository-live.ts";

const runsAfter = <E>(before: Effect.Effect<void, E, SqlClient.SqlClient>) =>
  RunsRepositoryLive.pipe(Layer.provideMerge(sqliteAfter(before)));

const run = (id: string, startedAt: string, persona: Option.Option<string>) =>
  RunRoot.make({
    id: RunId.make(id),
    coreVersion: "0.6.0",
    repo: "demo",
    persona,
    flow: "review",
    itemKey: "pr-1",
    itemTitle: Option.some("Fix it"),
    itemUrl: Option.none(),
    item: Option.none(),
    executionId: Option.none(),
    status: "running",
    currentStep: Option.none(),
    summary: Option.none(),
    startedAt,
    finishedAt: Option.none(),
  });

// It keeps its work item, as its trigger reported it.
const first = RunRoot.make({
  ...run("a", "2026-10-20T00:00:00Z", Option.some("bob")),
  item: Option.some({ key: "pr-1", title: "Fix it", data: { number: 1 }, signals: ["ci"] }),
});

const second = run("b", "2026-10-21T00:00:00Z", Option.none());

const finished = RunRoot.make({
  ...first,
  status: "done",
  summary: Option.some("merged"),
  finishedAt: Option.some("2026-10-22T00:00:00Z"),
});

describe("RunsRepositoryLive", () => {
  effect("saves runs and reads them back by id, running, latest and repo", () =>
    Effect.gen(function* () {
      const runs = yield* RunsRepository;
      yield* runs.save(second);
      yield* runs.save(first);
      yield* runs.save(RunRoot.make({ ...second, id: RunId.make("c"), repo: "other" }));

      expect(yield* runs.findOne(RunId.make("a"))).toEqual(Option.some(first));
      expect(yield* runs.findOne(RunId.make("nope"))).toEqual(Option.none());
      expect((yield* runs.findAll({ running: true })).map((found) => String(found.id))).toEqual([
        "a",
        "b",
        "c",
      ]);
      expect((yield* runs.findAll({ latest: 2 })).map((found) => String(found.id))).toEqual([
        "b",
        "c",
      ]);
      expect((yield* runs.findAll({ repo: "demo" })).map((found) => String(found.id))).toEqual([
        "a",
        "b",
      ]);
    }).pipe(Effect.provide(runsAfter(Effect.void))),
  );

  effect("a run that ended isn't rewritten by a copy saved from before it ended", () =>
    Effect.gen(function* () {
      const runs = yield* RunsRepository;
      yield* runs.save(first);
      yield* runs.save(finished);
      yield* runs.save(RunRoot.make({ ...first, currentStep: Option.some("late") }));

      expect(yield* runs.findOne(first.id)).toEqual(Option.some(finished));

      // A copy of it as it ended still saves, as adopting it does.
      const adopted = RunRoot.make({ ...finished, persona: Option.some("alice") });
      yield* runs.save(adopted);
      expect(yield* runs.findOne(first.id)).toEqual(Option.some(adopted));
    }).pipe(Effect.provide(runsAfter(Effect.void))),
  );

  effect("keeps the subjects a run named, in order, and a stale copy drops none", () =>
    Effect.gen(function* () {
      const runs = yield* RunsRepository;
      yield* runs.save(first);
      const named = RunRoot.make({ ...first, subjects: ["pr-124", "release-1.4", "pr-125"] });
      yield* runs.save(named);
      yield* runs.save(RunRoot.make({ ...first, currentStep: Option.some("stale") }));

      expect(Option.map(yield* runs.findOne(first.id), (found) => found.subjects)).toEqual(
        Option.some(["pr-124", "release-1.4", "pr-125"]),
      );
      expect((yield* runs.findAll({ running: true })).map((found) => found.subjects)).toEqual([
        ["pr-124", "release-1.4", "pr-125"],
      ]);
    }).pipe(Effect.provide(runsAfter(Effect.void))),
  );

  effect("a database from before personas and work items gains the columns, its runs neither", () =>
    Effect.gen(function* () {
      const runs = yield* RunsRepository;

      expect(
        Option.map(yield* runs.findOne(RunId.make("old")), (found) => ({
          persona: found.persona,
          item: found.item,
          subjects: found.subjects,
          status: found.status,
          coreVersion: found.coreVersion,
          configTree: found.configTree,
        })),
      ).toEqual(
        Option.some({
          persona: Option.none(),
          item: Option.none(),
          subjects: [],
          status: "running",
          // No core-providing binary resumes it.
          coreVersion: "0.0.0",
          configTree: Option.none(),
        }),
      );
    }).pipe(
      Effect.provide(
        runsAfter(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TABLE om_runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, flow TEXT NOT NULL, item_key TEXT NOT NULL, item_title TEXT, item_url TEXT, execution_id TEXT, status TEXT NOT NULL, current_step TEXT, summary TEXT, started_at TEXT NOT NULL, finished_at TEXT)`;
            yield* sql`CREATE INDEX om_runs_active ON om_runs (status, repo, flow, item_key)`;
            yield* sql`INSERT INTO om_runs (id, repo, flow, item_key, status, started_at) VALUES ('old', 'demo', 'review', 'pr-1', 'running', '2026-10-20T00:00:00Z')`;
          }),
        ),
      ),
    ),
  );

  effect("a database whose runs kept a pull request names it as each one's subject", () =>
    Effect.gen(function* () {
      const runs = yield* RunsRepository;
      const sql = yield* SqlClient.SqlClient;

      expect(Option.map(yield* runs.findOne(RunId.make("old")), (found) => found.subjects)).toEqual(
        Option.some(["pr-124"]),
      );
      expect(
        Option.map(yield* runs.findOne(RunId.make("none")), (found) => found.subjects),
      ).toEqual(Option.some([]));

      const columns = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('om_runs')`;
      expect(columns.map((column) => column.name)).not.toContain("pull_request");
    }).pipe(
      Effect.provide(
        runsAfter(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TABLE om_runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, flow TEXT NOT NULL, item_key TEXT NOT NULL, item_title TEXT, item_url TEXT, execution_id TEXT, status TEXT NOT NULL, current_step TEXT, summary TEXT, started_at TEXT NOT NULL, finished_at TEXT, persona TEXT, item TEXT, core_version TEXT, config_tree TEXT, pull_request INTEGER)`;
            yield* sql`INSERT INTO om_runs (id, repo, flow, item_key, status, core_version, started_at, pull_request) VALUES ('old', 'demo', 'implement', 'issue-1', 'done', '1.0.0', '2026-10-20T00:00:00Z', 124)`;
            yield* sql`INSERT INTO om_runs (id, repo, flow, item_key, status, core_version, started_at) VALUES ('none', 'demo', 'implement', 'issue-2', 'done', '1.0.0', '2026-10-20T00:00:00Z')`;
          }),
        ),
      ),
    ),
  );

  effect(
    "a database from before core keeps each run's SDK as its core, which no core-providing binary resumes, and gains its tree",
    () =>
      Effect.gen(function* () {
        const runs = yield* RunsRepository;

        expect(
          Option.map(yield* runs.findOne(RunId.make("old")), (found) => [
            found.coreVersion,
            found.configTree,
          ]),
        ).toEqual(Option.some(["0.7.0", Option.none()]));

        const saved = RunRoot.make({
          ...run("new", "2026-10-28T00:00:00Z", Option.none()),
          configTree: Option.some("abc123"),
        });

        yield* runs.save(saved);
        expect(yield* runs.findOne(saved.id)).toEqual(Option.some(saved));
      }).pipe(
        Effect.provide(
          runsAfter(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`CREATE TABLE om_runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, flow TEXT NOT NULL, item_key TEXT NOT NULL, item_title TEXT, item_url TEXT, execution_id TEXT, status TEXT NOT NULL, current_step TEXT, summary TEXT, started_at TEXT NOT NULL, finished_at TEXT, persona TEXT, item TEXT, sdk_version TEXT, pull_request INTEGER)`;
              yield* sql`INSERT INTO om_runs (id, repo, flow, item_key, status, sdk_version, started_at) VALUES ('old', 'demo', 'review', 'pr-1', 'running', '0.7.0', '2026-10-20T00:00:00Z')`;
            }),
          ),
        ),
      ),
  );
});
