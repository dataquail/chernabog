// A log file that turns over each UTC day, as the daemon's does: lines go to
// daemon.log, and at the first write of a new day the day before's moves to
// daemon.<YYYY-MM-DD>.log, for the retention sweep to remove in time
// (sweepRotatedLogs). The file is opened by its path for each line, so a
// rename never leaves this writing to the old one.

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

export type DailyLog = { readonly log: (line: string) => Effect.Effect<void> };

const dayOf = (millis: number) => new Date(millis).toISOString().slice(0, 10);

const directoryOf = (path: string) =>
  Option.getOrElse(
    Option.liftPredicate(path.slice(0, path.lastIndexOf("/")), (dir) => dir.length > 0),
    () => ".",
  );

// Where `path`'s log of `day` goes: daemon.log's of 2026-10-30 is daemon.2026-10-30.log.
export const rotatedLogPath = (path: string, day: string) =>
  path.replace(/(\.[^./]*)?$/, (extension) => `.${day}${extension}`);

// Appends timestamped lines to `path`, turning it over at the first write of
// each new UTC day, by the clock. A file left from an earlier day, judged by
// when it was last written, turns over at the first write too.
export const dailyLogWriting = (
  path: string,
): Effect.Effect<DailyLog, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const writing = yield* Semaphore.make(1);

    const leftOn = yield* fs.stat(path).pipe(
      Effect.map((info) => Option.map(info.mtime, (at) => dayOf(at.getTime()))),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

    // The day of what the file holds now.
    const holding = yield* Ref.make(leftOn);

    // Moves the file to its day's name; onto the end of one already there.
    const turnOver = (day: string) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(path))) {
          return;
        }

        const rotated = rotatedLogPath(path, day);

        if (yield* fs.exists(rotated)) {
          yield* fs.writeFileString(rotated, yield* fs.readFileString(path), { flag: "a" });
          yield* fs.remove(path);
        } else {
          yield* fs.rename(path, rotated);
        }
      });

    const log = (line: string) =>
      Effect.gen(function* () {
        const today = dayOf(yield* Clock.currentTimeMillis);
        const held = yield* Ref.get(holding);

        if (Option.isSome(held) && held.value !== today) {
          yield* turnOver(held.value);
        }

        const at = DateTime.formatIso(yield* DateTime.now);
        yield* fs.makeDirectory(directoryOf(path), { recursive: true });
        yield* fs.writeFileString(path, `${at} ${line}\n`, { flag: "a" });
        yield* Ref.set(holding, Option.some(today));
      }).pipe(writing.withPermits(1), Effect.orDie);

    return { log };
  });
