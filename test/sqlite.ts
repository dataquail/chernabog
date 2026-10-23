// A SQLite database in memory, for a store's live test: `before` runs against
// it first, as a database an older chernabog left would be.

import { SqliteClient } from "@effect/sql-sqlite-bun";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";

export const sqliteAfter = <E>(before: Effect.Effect<void, E, SqlClient.SqlClient>) =>
  Layer.effectDiscard(before).pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
    Layer.orDie,
  );
