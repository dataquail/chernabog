import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { effect } from "../../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../../test/sqlite.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunWaitRoot } from "../../domain/run-wait/run-wait.root.ts";
import { RunWaitSpecifications } from "../../domain/run-wait/run-wait.specification.ts";
import { RunWaitsRepository } from "../../domain/run-wait/run-waits.repository.ts";
import { RunWaitsRepositoryLive } from "./run-waits.repository-live.ts";

const wait = (runId: string, deferred: string, token: string) =>
  RunWaitRoot.make({
    runId: RunId.make(runId),
    signal: "pushed",
    deferred,
    token,
    parkedAt: Option.none(),
  });

describe("RunWaitsRepositoryLive", () => {
  effect("upserts waits, replacing a run's wait on the same deferred, and removes them", () =>
    Effect.gen(function* () {
      const waits = yield* RunWaitsRepository;
      yield* waits.upsertOne(wait("a", "d1", "t1"));
      yield* waits.upsertOne(wait("a", "d1", "t2"));
      yield* waits.upsertOne(wait("a", "d2", "t3"));
      yield* waits.upsertOne(wait("b", "d1", "t4"));

      expect(
        (yield* waits.findMany(RunWaitSpecifications.forRun(RunId.make("a")))).map(
          (found) => found.token,
        ),
      ).toEqual(["t2", "t3"]);
      expect((yield* waits.findMany(RunWaitSpecifications.all)).length).toBe(3);

      yield* waits.deleteOne(wait("a", "d1", "t2"));
      expect(
        (yield* waits.findMany(RunWaitSpecifications.forRun(RunId.make("a")))).map(
          (found) => found.deferred,
        ),
      ).toEqual(["d2"]);
    }).pipe(Effect.provide(RunWaitsRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void))))),
  );

  effect(
    "a table from before waits kept when they parked gains the column, its waits with none",
    () =>
      Effect.gen(function* () {
        const waits = yield* RunWaitsRepository;
        yield* waits.upsertOne(
          RunWaitRoot.make({
            runId: RunId.make("b"),
            signal: "pushed",
            deferred: "d2",
            token: "t2",
            parkedAt: Option.some("2026-10-20T00:00:00.000Z"),
          }),
        );

        expect(
          (yield* waits.findMany(RunWaitSpecifications.all)).map((found) => found.parkedAt),
        ).toEqual([Option.none(), Option.some("2026-10-20T00:00:00.000Z")]);
      }).pipe(
        Effect.provide(
          RunWaitsRepositoryLive.pipe(
            Layer.provide(
              sqliteAfter(
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* sql`CREATE TABLE om_waits (run_id TEXT NOT NULL, signal TEXT NOT NULL, deferred TEXT NOT NULL, token TEXT NOT NULL, PRIMARY KEY (run_id, deferred))`;
                  yield* sql`INSERT INTO om_waits VALUES ('a', 'pushed', 'd1', 't1')`;
                }),
              ),
            ),
          ),
        ),
      ),
  );
});
