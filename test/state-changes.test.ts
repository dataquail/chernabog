// The daemon's watch on the files its bus can't hear about: a change another
// process makes is said once a window; one this process makes, never.

import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { Exec } from "../src/platform/exec.ts";
import { updateFile } from "../src/platform/file-lock.ts";
import { bunExecutable } from "../src/platform/self.ts";
import { watchStateChanges } from "../src/platform/state-changes.ts";
import { effect } from "./effect-test.ts";
import { sqliteAt } from "./sqlite.ts";

const DataVersion = Schema.Array(Schema.Struct({ data_version: Schema.Int }));

// state.db's data_version on the connection in context, as the runs module's
// ReadStateVersionQuery reads it.
const dataVersion = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* Schema.decodeUnknownEffect(DataVersion)(yield* sql`PRAGMA data_version`);

  return Option.getOrElse(
    Option.map(Option.fromUndefinedOr(rows[0]), (row) => row.data_version),
    () => 0,
  );
}).pipe(Effect.orDie);

// Runs `script` in a shell of its own, as a person's editor or another
// process would change a file.
const inAnotherProcess = (script: string) =>
  Exec.use((exec) => exec.run("sh", ["-c", script], { cwd: "/" }));

// Appends a line to a file of `dir` from another process.
const editElsewhere = (dir: string, name: string) =>
  inAnotherProcess(`printf '# edited\\n' >> '${dir}/${name}'`);

// Commits to the database at `path` from another process, over its own connection.
const commitElsewhere = (path: string) =>
  Exec.use((exec) =>
    exec.run(
      bunExecutable(),
      [
        "-e",
        `const { Database } = require("bun:sqlite"); new Database("${path}").run("INSERT INTO om_test (n) VALUES (2)");`,
      ],
      { cwd: "/" },
    ),
  );

// A scratch home with machine config, paused.json, trust.json and a state.db
// in it; the batches the watch on it says, in a queue; and the connection the
// watch reads state.db's version on, as the daemon's.
const watching = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-state-changes-" });
  yield* fs.writeFileString(`${dir}/config.yaml`, "repos: []\n");
  yield* fs.writeFileString(`${dir}/paused.json`, "{}\n");
  yield* fs.writeFileString(`${dir}/trust.json`, "{}\n");

  const own = yield* Layer.build(sqliteAt(`${dir}/state.db`));
  const ownSql = Effect.provideContext(own);
  yield* ownSql(SqlClient.SqlClient.use((sql) => sql`CREATE TABLE om_test (n INTEGER)`));

  const said = yield* Queue.unbounded<ReadonlyArray<string>>();

  yield* Effect.forkScoped(
    Stream.runForEach(
      watchStateChanges({
        dir,
        files: ["config.yaml", "paused.json", "trust.json"],
        database: { name: "state.db", version: ownSql(dataVersion) },
        window: "300 millis",
      }),
      (changed) => Queue.offer(said, changed),
    ),
  );

  // Armed once a change to trust.json, tried until one is, has been said.
  yield* editElsewhere(dir, "trust.json").pipe(
    Effect.andThen(Queue.take(said).pipe(Effect.timeoutOption("500 millis"))),
    Effect.repeat({ until: Option.isSome, times: 20 }),
  );

  // The next batch said.
  const next = Queue.take(said);

  return { dir, ownSql, next };
});

describe("watchStateChanges", () => {
  effect("says a hand edit of machine config by another process once", () =>
    Effect.gen(function* () {
      const { dir, next } = yield* watching;

      yield* inAnotherProcess(
        `printf 'concurrency: 2\\n' >> '${dir}/config.yaml' && printf 'quietHours: []\\n' >> '${dir}/config.yaml'`,
      );
      expect(yield* next).toEqual(["config.yaml"]);

      // Nothing more of it: the next batch is the next change.
      yield* editElsewhere(dir, "paused.json");
      expect(yield* next).toEqual(["paused.json"]);
    }).pipe(Effect.provide(Exec.layer)),
  );

  effect("says nothing of a change this process made", () =>
    Effect.gen(function* () {
      const { dir, next } = yield* watching;
      const fs = yield* FileSystem.FileSystem;

      yield* updateFile(fs, `${dir}/paused.json`, "test", () =>
        Effect.succeed([true, Option.some('{"acme/widgets": true}\n')] as const),
      );
      yield* editElsewhere(dir, "config.yaml");

      expect(yield* next).toEqual(["config.yaml"]);
    }).pipe(Effect.provide(Exec.layer)),
  );

  effect("says another connection's commit to state.db, and not its own", () =>
    Effect.gen(function* () {
      const { dir, next, ownSql } = yield* watching;

      yield* ownSql(SqlClient.SqlClient.use((sql) => sql`INSERT INTO om_test (n) VALUES (1)`));
      yield* editElsewhere(dir, "config.yaml");
      expect(yield* next).toEqual(["config.yaml"]);

      yield* commitElsewhere(`${dir}/state.db`);
      expect(yield* next).toEqual(["state.db"]);
    }).pipe(Effect.provide(Exec.layer)),
  );
});
