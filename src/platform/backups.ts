// Machine config and state.db are stamped with the chernabog that last
// migrated them. Before a newer binary migrates either one up, it keeps a copy
// under the chernabog home's backups/, named for the version it came from, so
// rolling back is installing that version again and restoring its copy. There
// are no down migrations: an older binary has never seen the newer ones, and
// some would lose data. A binary that finds a stamp newer than itself refuses
// to read the file, and says how to restore.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

import { homePaths } from "./home.ts";
import { VERSION } from "./version.ts";

// How many copies of each file are kept, the newest first.
export const BACKUPS_KEPT = 3;

// What a stamp says about the file it's on, to this binary: up to date,
// older (or unstamped, from before stamps), so it migrates it up, or newer, so
// it refuses it.
export type StampState = "current" | "older" | "newer";

export const stampState = (stamp: Option.Option<string>): StampState =>
  Option.match(stamp, {
    onNone: () => "older",
    onSome: (version) => {
      const order = Bun.semver.order(version, VERSION);

      if (order > 0) {
        return "newer";
      }

      if (order < 0) {
        return "older";
      }

      return "current";
    },
  });

// The version a copy is named for: the stamp it had, or, unstamped, what it
// came before.
const fromVersion = (stamp: Option.Option<string>) =>
  Option.getOrElse(stamp, () => `before-${VERSION}`);

// Where the copy of `file` (config.yaml, state.db) from `stamp` is kept.
export const backupPath = (root: string, file: string, stamp: Option.Option<string>) =>
  `${homePaths(root).backups}/${file}.${fromVersion(stamp)}`;

export type Backup = { readonly path: string; readonly file: string; readonly modified: Date };

// The copies kept of `file`, the newest first.
export const listBackups = (root: string, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = homePaths(root).backups;

    if (!(yield* fs.exists(dir))) {
      return [];
    }

    const found: Array<Backup> = [];

    for (const name of yield* fs.readDirectory(dir)) {
      if (!name.startsWith(`${file}.`)) {
        continue;
      }

      const info = yield* fs.stat(`${dir}/${name}`);

      found.push({
        path: `${dir}/${name}`,
        file,
        modified: Option.getOrElse(info.mtime, () => new Date(0)),
      });
    }

    return Arr.sort(
      found,
      Order.flip(Order.mapInput(Order.Date, (backup: Backup) => backup.modified)),
    );
  });

// Keeps a copy of `file` from `stamp`, made by `copy` at the path it's given,
// and drops the oldest past BACKUPS_KEPT. Returns where the copy is.
export const keepBackup = <E, R>(
  root: string,
  file: string,
  stamp: Option.Option<string>,
  copy: (path: string) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = backupPath(root, file, stamp);
    yield* fs.makeDirectory(homePaths(root).backups, { recursive: true });
    yield* fs.remove(path, { force: true });
    yield* copy(path);

    const others = (yield* listBackups(root, file)).filter((backup) => backup.path !== path);

    for (const old of others.slice(BACKUPS_KEPT - 1)) {
      yield* fs.remove(old.path, { force: true });
    }

    return path;
  });

// Why this binary won't read a file a newer chernabog migrated, and how to
// roll back to it: restore the copy kept for this version, if there is one.
export const describeNewerStamp = (
  root: string,
  what: string,
  live: string,
  file: string,
  stamp: string,
) =>
  Effect.gen(function* () {
    const mine = backupPath(root, file, Option.some(VERSION));
    const kept = yield* FileSystem.FileSystem.use((fs) => fs.exists(mine));

    const how = Option.match(
      Option.liftPredicate(mine, () => kept),
      {
        onNone: () =>
          `there's no copy of it from ${VERSION} in ${homePaths(root).backups} to roll back to`,
        onSome: (copy) =>
          `roll back: stop the daemon (chernabog stop), then restore the copy kept for ${VERSION} with cp ${copy} ${live}`,
      },
    );

    return `${what} was last migrated by chernabog ${stamp}, newer than this ${VERSION}, so this chernabog won't read it. Upgrade chernabog, or ${how}`;
  }).pipe(
    Effect.orElseSucceed(
      () =>
        `${what} was last migrated by chernabog ${stamp}, newer than this ${VERSION}, so this chernabog won't read it; upgrade chernabog`,
    ),
  );
