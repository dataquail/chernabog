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
  RunsRepositoryLive.pipe(Layer.provide(sqliteAfter(before)));

const run = (id: string, startedAt: string, persona: Option.Option<string>) =>
  RunRoot.make({
    id: RunId.make(id),
    sdkVersion: "0.6.0",
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

  effect("keeps the pull request a run opened", () =>
    Effect.gen(function* () {
      const runs = yield* RunsRepository;
      yield* runs.save(first);
      const linked = RunRoot.make({ ...first, pullRequest: Option.some(124) });
      yield* runs.save(linked);

      expect(yield* runs.findOne(first.id)).toEqual(Option.some(linked));
    }).pipe(Effect.provide(runsAfter(Effect.void))),
  );

  effect("a database from before personas and work items gains the columns, its runs neither", () =>
    Effect.gen(function* () {
      const runs = yield* RunsRepository;

      expect(
        Option.map(yield* runs.findOne(RunId.make("old")), (found) => ({
          persona: found.persona,
          item: found.item,
          pullRequest: found.pullRequest,
          status: found.status,
        })),
      ).toEqual(
        Option.some({
          persona: Option.none(),
          item: Option.none(),
          pullRequest: Option.none(),
          status: "running",
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
});
