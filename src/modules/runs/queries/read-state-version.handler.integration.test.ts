import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { effect } from "../../../../test/effect-test.ts";
import { sqliteAt } from "../../../../test/sqlite.ts";
import { readStateVersionHandler } from "./read-state-version.handler.ts";

const insert = (n: number) =>
  SqlClient.SqlClient.use((sql) => sql`INSERT INTO om_test (n) VALUES (${n})`);

describe("readStateVersionHandler", () => {
  effect("moves for another connection's commit, and not for this one's", () =>
    Effect.gen(function* () {
      const dir = yield* FileSystem.FileSystem.use((fs) =>
        fs.makeTempDirectoryScoped({ prefix: "chernabog-state-version-" }),
      );

      // This process's connection, and another's, as a foreground run's would be.
      const own = Effect.provideContext(yield* Layer.build(sqliteAt(`${dir}/state.db`)));
      const other = Effect.provideContext(yield* Layer.build(sqliteAt(`${dir}/state.db`)));

      yield* own(SqlClient.SqlClient.use((sql) => sql`CREATE TABLE om_test (n INTEGER)`));
      const first = (yield* own(readStateVersionHandler())).version;

      yield* own(insert(1));
      expect((yield* own(readStateVersionHandler())).version).toBe(first);

      yield* other(insert(2));
      expect((yield* own(readStateVersionHandler())).version).not.toBe(first);
    }),
  );
});
