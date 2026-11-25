// state.db is stamped with the chernabog that last migrated it, in om_meta.
// Before the workflow engine and the runs' stores migrate it, a database a
// newer chernabog stamped is refused, and one an older chernabog stamped (or
// none did) is copied to the backups first, whole and consistent (VACUUM
// INTO, so the WAL comes too), then stamped with this one.
//
// The workflow engine's tables, which state.db held before each run had a
// journal of its own (ADR 23, decision 3), are dropped once it is ready:
// nothing reads them, and a run they journaled ends interrupted at the hub's
// first start and repeats its phase.

import { Database } from "bun:sqlite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { describeNewerStamp, keepBackup, stampState } from "../../../../platform/backups.ts";
import { ConfigError } from "../../../../platform/config-error.ts";
import { VERSION } from "../../../../platform/version.ts";

const STAMP = "chernabog";

type Row = { readonly value: string };

const readStamp = (db: Database) => {
  const hasMeta = Option.fromNullishOr(
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'om_meta'").get(),
  );

  if (Option.isNone(hasMeta)) {
    return Option.none<string>();
  }

  return Option.map(
    Option.fromNullishOr(
      db.query<Row, [string]>("SELECT value FROM om_meta WHERE key = ?").get(STAMP),
    ),
    (row) => row.value,
  );
};

// Whether the database holds anything yet: a new one needs no copy.
const isEmpty = (db: Database) =>
  Option.isNone(
    Option.fromNullishOr(
      db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get(),
    ),
  );

const writeStamp = (db: Database) => {
  db.run("CREATE TABLE IF NOT EXISTS om_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run(
    "INSERT INTO om_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [STAMP, VERSION],
  );
};

// The workflow engine's tables in state.db from before runs had journals of
// their own (cluster_messages, cluster_replies, cluster_migrations, and any
// other the engine made there), dropped. Which it dropped.
export const dropEngineTables = (db: Database) => {
  const tables = db
    .query<{ readonly name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cluster\\_%' ESCAPE '\\'",
    )
    .all()
    .map((row) => row.name);

  for (const table of tables) {
    db.run(`DROP TABLE IF EXISTS "${table}"`);
  }

  return tables;
};

// What preparing state.db did: the copy it kept before moving it up, if any.
export type StatePrepared = { readonly kept: Option.Option<string> };

// Readies `database` for this binary, under the chernabog home at `root`:
// refused when a newer chernabog stamped it; copied and stamped when an older
// one did, or none did.
export const prepareState = (root: string, database: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(database.slice(0, database.lastIndexOf("/")), { recursive: true });

    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(database, { create: true })),
      (opened) =>
        Effect.sync(() => {
          opened.close();
        }),
    );

    const stamp = readStamp(db);

    switch (stampState(stamp)) {
      case "current": {
        dropEngineTables(db);

        return { kept: Option.none() } satisfies StatePrepared;
      }

      case "newer": {
        return yield* new ConfigError({
          message: yield* describeNewerStamp(
            root,
            "state.db",
            database,
            "state.db",
            Option.getOrElse(stamp, () => ""),
          ),
        });
      }

      case "older": {
        const kept = yield* Option.match(
          Option.liftPredicate(db, (opened) => !isEmpty(opened)),
          {
            onNone: () => Effect.succeedNone,
            onSome: (opened) =>
              keepBackup(root, "state.db", stamp, (path) =>
                Effect.sync(() => opened.run("VACUUM INTO ?", [path])),
              ).pipe(Effect.asSome),
          },
        );

        writeStamp(db);
        dropEngineTables(db);

        return { kept } satisfies StatePrepared;
      }
    }
  }).pipe(Effect.scoped);
