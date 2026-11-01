// Replacing a file chernabog keeps state in, so a process killed partway
// leaves the old contents or the new, never a truncated file. Writing in place
// truncates first, and machine config that's cut short reads as one that sets
// nothing: every repo unenrolled, which the next write would then save.

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

const encoder = new TextEncoder();

// Runs `use` with a path beside `path`, on the same filesystem, that no other
// write uses, in this process or another; it's removed after.
export const withStaging = <A, E, R>(
  fs: FileSystem.FileSystem,
  path: string,
  use: (staging: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const slash = path.lastIndexOf("/");

    const dir = yield* fs.makeTempDirectory({
      directory: path.slice(0, Math.max(slash, 1)),
      prefix: `${path.slice(slash + 1)}.`,
    });

    return yield* use(`${dir}/staging`).pipe(
      Effect.ensuring(fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore)),
    );
  });

// Writes `text` beside the file, flushes it to disk, then renames it over the
// file, which is atomic within a directory. A file that's a symlink, as one
// kept in a person's dotfiles is, stays one: its target is what's replaced.
// `mode` is the new file's permissions before the umask, such as 0o600 for a
// secret only the person may read, which it has from the moment it's written.
export const writeFileAtomic = (
  fs: FileSystem.FileSystem,
  path: string,
  text: string,
  mode = 0o666,
) =>
  Effect.gen(function* () {
    let target = path;

    if (yield* fs.exists(path)) {
      target = yield* fs.realPath(path);
    }

    yield* withStaging(fs, target, (staging) =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(staging, { flag: "w", mode });
            yield* file.writeAll(encoder.encode(text));
            yield* file.sync;
          }),
        );
        yield* fs.rename(staging, target);
      }),
    );
  });
