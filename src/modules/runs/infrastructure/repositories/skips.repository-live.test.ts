import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { effect } from "../../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../../test/sqlite.ts";
import { SkipRoot } from "../../domain/skip/skip.root.ts";
import { SkipSpecifications } from "../../domain/skip/skip.specification.ts";
import { SkipsRepository } from "../../domain/skip/skips.repository.ts";
import { SkipsRepositoryLive } from "./skips.repository-live.ts";

const skipsAfter = <E>(before: Effect.Effect<void, E, SqlClient.SqlClient>) =>
  SkipsRepositoryLive.pipe(Layer.provide(sqliteAfter(before)));

const skip = (reason: string, at: string) =>
  SkipRoot.make({
    repo: "demo",
    persona: Option.some("bob"),
    flow: "review",
    itemKey: Option.none(),
    reason,
    at,
  });

describe("SkipsRepositoryLive", () => {
  effect("keeps every skip and reads back those a spec holds of, newest first", () =>
    Effect.gen(function* () {
      const skips = yield* SkipsRepository;
      yield* skips.insertOne(skip("paused", "2026-10-20T00:00:00Z"));
      yield* skips.insertOne(skip("usage gate", "2026-10-22T00:00:00Z"));
      yield* skips.insertOne(skip("quiet hours", "2026-10-21T00:00:00Z"));

      expect((yield* skips.findMany(SkipSpecifications.all)).map((found) => found.reason)).toEqual([
        "usage gate",
        "quiet hours",
        "paused",
      ]);
      expect(yield* skips.findMany(SkipSpecifications.forFlow("demo", "other"))).toEqual([]);
    }).pipe(Effect.provide(skipsAfter(Effect.void))),
  );

  effect("a database from before personas gains the column, its skips the implicit persona", () =>
    Effect.gen(function* () {
      expect(
        (yield* (yield* SkipsRepository).findMany(SkipSpecifications.all)).map(
          (found) => found.persona,
        ),
      ).toEqual([Option.none()]);
    }).pipe(
      Effect.provide(
        skipsAfter(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TABLE om_skips (repo TEXT NOT NULL, flow TEXT NOT NULL, item_key TEXT, reason TEXT NOT NULL, at TEXT NOT NULL)`;
            yield* sql`INSERT INTO om_skips (repo, flow, reason, at) VALUES ('demo', 'review', 'usage gate', '2026-10-20T00:00:00Z')`;
          }),
        ),
      ),
    ),
  );
});
