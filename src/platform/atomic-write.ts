// Replacing a file chernabog keeps state in, so a process killed partway
// leaves the old contents or the new, never a truncated file. Writing in place
// truncates first, and machine config that's cut short reads as one that sets
// nothing: every repo unenrolled, which the next write would then save.

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

const encoder = new TextEncoder();

// Writes `text` beside the file, flushes it to disk, then renames it over the
// file, which is atomic within a directory. A file that's a symlink, as one
// kept in a person's dotfiles is, stays one: its target is what's replaced.
export const writeFileAtomic = (fs: FileSystem.FileSystem, path: string, text: string) =>
  Effect.gen(function* () {
    let target = path;

    if (yield* fs.exists(path)) {
      target = yield* fs.realPath(path);
    }

    const staging = `${target}.${process.pid}.tmp`;

    const replace = Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(staging, { flag: "w" });
          yield* file.writeAll(encoder.encode(text));
          yield* file.sync;
        }),
      );
      yield* fs.rename(staging, target);
    });

    yield* replace.pipe(
      Effect.onError(() => fs.remove(staging, { force: true }).pipe(Effect.ignore)),
    );
  });
