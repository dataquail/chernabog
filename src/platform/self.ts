// How to run this same program again: the compiled binary, or bun on the source
// entry point during development.

import { fileURLToPath } from "node:url";

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

export const SOURCE_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

// Homebrew runs a formula's binary from <prefix>/Cellar/<name>/<version>/,
// which `brew upgrade` deletes, and keeps <prefix>/opt/<name> linked to the
// current version. What this command is written into, a launchd plist, a
// systemd unit or a hook, has to outlive an upgrade, so it names the opt path.
export const stableExecutable = (path: string) =>
  path.replace(/^(.*)\/Cellar\/([^/]+)\/[^/]+\//, "$1/opt/$2/");

export const selfCommand = (): ReadonlyArray<string> => {
  if (Bun.isStandaloneExecutable) {
    return [stableExecutable(process.execPath)];
  }

  return [process.execPath, `${SOURCE_ROOT}/src/interface/cli/main.ts`];
};

// bun itself, for `bun install`: the compiled binary acts as bun when BUN_BE_BUN
// is set, and from source this is bun already.
export const bunExecutable = () => process.execPath;

// The file the daemon watches for an upgrade: the binary, by the path that
// outlives one (CHERNABOG_EXECUTABLE names another, for tests); none from
// source, where nothing installs over it.
export const watchedExecutable = Config.option(Config.String("CHERNABOG_EXECUTABLE")).pipe(
  Effect.map((named) =>
    Option.orElse(named, () =>
      Option.liftPredicate(stableExecutable(process.execPath), () => Bun.isStandaloneExecutable),
    ),
  ),
  Effect.orElseSucceed(() => Option.none<string>()),
);

// What a file is now: the file its path resolves to, and when that last
// changed. `brew upgrade` relinks the opt path to a new version's file, and an
// install over it in place changes its time, so either changes this; none
// while it can't be read, as partway through an install.
export const fileIdentity = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const real = yield* fs.realPath(path);
    const info = yield* fs.stat(real);
    const modified = Option.match(info.mtime, { onNone: () => 0, onSome: (at) => at.getTime() });

    return Option.some(`${real}:${String(info.ino)}:${String(info.size)}:${String(modified)}`);
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));
