import { makeUnitOfWork, TransactionDriver, UnitOfWork } from "@effect-server-utils/unit-of-work";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { effect } from "../../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../../test/sqlite.ts";
import { StateDbTransactionDriverLive } from "./state-db.transaction-driver-live.ts";

const Row = Schema.Struct({ name: Schema.String });

const database = sqliteAfter(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE things (name TEXT NOT NULL)`;
  }),
);

const unitOfWork = makeUnitOfWork().pipe(
  Layer.provideMerge(StateDbTransactionDriverLive),
  Layer.provideMerge(database),
);

const insert = (name: string) =>
  SqlClient.SqlClient.use((sql) => sql`INSERT INTO things (name) VALUES (${name})`).pipe(
    Effect.orDie,
  );

const names = SqlClient.SqlClient.use((sql) => sql`SELECT name FROM things ORDER BY name`).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Row))),
  Effect.map((rows) => rows.map((row) => row.name)),
  Effect.orDie,
);

const run = <A, E, R>(work: Effect.Effect<A, E, R>) => UnitOfWork.use((uow) => uow.run(work));

describe("StateDbTransactionDriverLive", () => {
  effect("commits what a unit of work wrote when it succeeds", () =>
    Effect.gen(function* () {
      yield* run(Effect.andThen(insert("a"), insert("b")));

      expect(yield* names).toEqual(["a", "b"]);
    }).pipe(Effect.provide(unitOfWork)),
  );

  effect("discards everything a unit of work wrote when it fails after its first write", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        run(insert("a").pipe(Effect.andThen(Effect.fail("boom")), Effect.andThen(insert("b")))),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* names).toEqual([]);
    }).pipe(Effect.provide(unitOfWork)),
  );

  effect("discards it on a defect too", () =>
    Effect.gen(function* () {
      yield* Effect.exit(run(insert("a").pipe(Effect.andThen(Effect.die("boom")))));

      expect(yield* names).toEqual([]);
    }).pipe(Effect.provide(unitOfWork)),
  );

  effect("a nested unit of work is a savepoint: its failure, caught, discards only its own", () =>
    Effect.gen(function* () {
      yield* run(
        Effect.gen(function* () {
          yield* insert("outer");
          yield* Effect.exit(run(insert("inner").pipe(Effect.andThen(Effect.fail("boom")))));
          yield* run(insert("kept"));
        }),
      );

      expect(yield* names).toEqual(["kept", "outer"]);
    }).pipe(Effect.provide(unitOfWork)),
  );

  effect("says a transaction is open only inside one", () =>
    Effect.gen(function* () {
      const open = TransactionDriver.use((driver) => driver.isActive);

      expect(yield* open).toBe(false);
      expect(yield* run(open)).toBe(true);
    }).pipe(Effect.provide(unitOfWork)),
  );
});
