import { SqliteClient } from "@effect/sql-sqlite-bun";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { State } from "../src/state.ts";
import { effect } from "./effect-test.ts";

// State over a fresh in-memory database, after `before` has run against it.
const stateAfter = <E>(before: Effect.Effect<void, E, SqlClient.SqlClient>) =>
  State.layer.pipe(
    Layer.provide(
      Layer.effectDiscard(before).pipe(
        Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
    Layer.orDie,
  );

const newRun = (id: string, persona: Option.Option<string>) => ({
  id,
  repo: "demo",
  persona,
  flow: "review",
  itemKey: "pr-1",
  itemTitle: Option.none(),
  itemUrl: Option.none(),
});

describe("state", () => {
  const before = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE om_runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, flow TEXT NOT NULL, item_key TEXT NOT NULL, item_title TEXT, item_url TEXT, execution_id TEXT, status TEXT NOT NULL, current_step TEXT, summary TEXT, started_at TEXT NOT NULL, finished_at TEXT)`;
    yield* sql`CREATE INDEX om_runs_active ON om_runs (status, repo, flow, item_key)`;
    yield* sql`CREATE TABLE om_skips (repo TEXT NOT NULL, flow TEXT NOT NULL, item_key TEXT, reason TEXT NOT NULL, at TEXT NOT NULL)`;
    yield* sql`INSERT INTO om_runs (id, repo, flow, item_key, status, started_at) VALUES ('old', 'demo', 'review', 'pr-1', 'running', '2026-10-20T00:00:00Z')`;
    yield* sql`INSERT INTO om_skips (repo, flow, reason, at) VALUES ('demo', 'review', 'usage gate', '2026-10-20T00:00:00Z')`;
  });

  effect(
    "a database from before personas gains the column, and its runs read as the implicit persona",
    () =>
      Effect.gen(function* () {
        const state = yield* State;

        expect(Option.map(yield* state.run("old"), (run) => run.persona)).toEqual(
          Option.some(Option.none()),
        );
        expect(
          Option.isSome(yield* state.activeRunFor("demo", Option.none(), "review", "pr-1")),
        ).toBe(true);
        expect((yield* state.recentSkips(5)).map((skip) => skip.persona)).toEqual([Option.none()]);
      }).pipe(Effect.provide(stateAfter(before))),
  );

  effect("one item's run in flight is per persona", () =>
    Effect.gen(function* () {
      const state = yield* State;
      yield* state.insertRun(newRun("as-bob", Option.some("bob")));

      expect(
        Option.map(
          yield* state.activeRunFor("demo", Option.some("bob"), "review", "pr-1"),
          (run) => run.id,
        ),
      ).toEqual(Option.some("as-bob"));
      expect(yield* state.activeRunFor("demo", Option.some("alice"), "review", "pr-1")).toEqual(
        Option.none(),
      );
      expect(yield* state.activeRunFor("demo", Option.none(), "review", "pr-1")).toEqual(
        Option.none(),
      );
      expect(
        (yield* state.activeRuns({
          repo: Option.none(),
          persona: Option.some(Option.some("alice")),
          flow: Option.none(),
        })).length,
      ).toBe(0);
    }).pipe(Effect.provide(stateAfter(Effect.void))),
  );

  effect(
    "adopting gives a repo's runs from before personas a persona, and leaves others alone",
    () =>
      Effect.gen(function* () {
        const state = yield* State;
        yield* state.insertRun(newRun("implicit", Option.none()));
        yield* state.insertRun({ ...newRun("other-repo", Option.none()), repo: "other" });
        yield* state.insertRun({ ...newRun("as-bob", Option.some("bob")), itemKey: "pr-2" });
        yield* state.adoptRuns("demo", "alice");

        const personaOf = (id: string) =>
          Effect.map(state.run(id), (run) => Option.flatMap(run, (found) => found.persona));

        expect(yield* personaOf("implicit")).toEqual(Option.some("alice"));
        expect(yield* personaOf("other-repo")).toEqual(Option.none());
        expect(yield* personaOf("as-bob")).toEqual(Option.some("bob"));
      }).pipe(Effect.provide(stateAfter(Effect.void))),
  );
});
