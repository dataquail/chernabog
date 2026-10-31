import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { StateVersion } from "./read-state-version.query.ts";

const DataVersion = Schema.Array(Schema.Struct({ data_version: Schema.Int }));

export const readStateVersionHandler = Effect.fn("readStateVersionHandler")(function* () {
  const sql = yield* SqlClient.SqlClient;

  // SQLite's data_version, which counts the commits of every other connection
  // to the database file since this one opened it, and none of its own. A
  // failure to read a pragma is a bug, not a condition.
  const rows = yield* sql`PRAGMA data_version`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(DataVersion)),
    Effect.orDie,
  );

  return StateVersion.make({ version: rows[0]?.data_version ?? 0 });
});
