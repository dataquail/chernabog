import { Database } from "bun:sqlite";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { prepareState } from "../src/modules/runs/infrastructure/runtime/state-stamp.ts";
import { Home, homePaths } from "../src/platform/home.ts";
import { VERSION } from "../src/platform/version.ts";
import { effectAtHome } from "./effect-test.ts";

// A state.db an earlier chernabog left: a run in om_runs, and its stamp, if any.
const leftBy = (path: string, stamp: Option.Option<string>) => {
  const db = new Database(path, { create: true });
  db.run("CREATE TABLE om_runs (id TEXT PRIMARY KEY)");
  db.run("INSERT INTO om_runs (id) VALUES ('run-1')");

  for (const version of Option.toArray(stamp)) {
    db.run("CREATE TABLE om_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.run("INSERT INTO om_meta (key, value) VALUES ('chernabog', ?)", [version]);
  }

  db.close();
};

const stampOf = (path: string) => {
  const db = new Database(path, { readonly: true });
  const row = db.query<{ value: string }, []>("SELECT value FROM om_meta").get();
  db.close();

  return row?.value;
};

const runsIn = (path: string) => {
  const db = new Database(path, { readonly: true });
  const rows = db.query<{ id: string }, []>("SELECT id FROM om_runs").all();
  db.close();

  return rows.map((row) => row.id);
};

const at = Effect.gen(function* () {
  const root = (yield* Home).root;

  return { fs: yield* FileSystem.FileSystem, root, paths: homePaths(root) };
});

describe("preparing state.db", () => {
  effectAtHome("a new one is stamped, with nothing to copy", () =>
    Effect.gen(function* () {
      const { fs, paths, root } = yield* at;

      expect(yield* prepareState(root, paths.state)).toEqual({ kept: Option.none() });
      expect(stampOf(paths.state)).toBe(VERSION);
      expect(yield* fs.exists(paths.backups)).toBe(false);
      expect(yield* prepareState(root, paths.state)).toEqual({ kept: Option.none() });
    }),
  );

  effectAtHome("one from before stamps is copied whole, then stamped", () =>
    Effect.gen(function* () {
      const { paths, root } = yield* at;
      leftBy(paths.state, Option.none());
      const copy = `${paths.backups}/state.db.before-${VERSION}`;

      expect(yield* prepareState(root, paths.state)).toEqual({ kept: Option.some(copy) });
      expect(runsIn(copy)).toEqual(["run-1"]);
      expect(stampOf(paths.state)).toBe(VERSION);
    }),
  );

  effectAtHome("an older chernabog's is copied under its version", () =>
    Effect.gen(function* () {
      const { paths, root } = yield* at;
      leftBy(paths.state, Option.some("0.0.1"));

      expect(yield* prepareState(root, paths.state)).toEqual({
        kept: Option.some(`${paths.backups}/state.db.0.0.1`),
      });
      expect(stampOf(`${paths.backups}/state.db.0.0.1`)).toBe("0.0.1");
    }),
  );

  effectAtHome("a newer chernabog's is refused, and this one's copy restored runs", () =>
    Effect.gen(function* () {
      const { fs, paths, root } = yield* at;
      const copy = `${paths.backups}/state.db.${VERSION}`;
      yield* fs.makeDirectory(paths.backups, { recursive: true });
      leftBy(copy, Option.some(VERSION));
      leftBy(paths.state, Option.some("99.0.0"));

      const refused = yield* Effect.result(prepareState(root, paths.state));
      expect(Result.isFailure(refused) && refused.failure.message).toBe(
        `state.db was last migrated by chernabog 99.0.0, newer than this ${VERSION}, so this chernabog won't read it. Upgrade chernabog, or roll back: stop the daemon (chernabog stop), then restore the copy kept for ${VERSION} with cp ${copy} ${paths.state}`,
      );
      expect(stampOf(paths.state)).toBe("99.0.0");

      yield* fs.copyFile(copy, paths.state);
      expect(yield* prepareState(root, paths.state)).toEqual({ kept: Option.none() });
      expect(runsIn(paths.state)).toEqual(["run-1"]);
    }),
  );
});
