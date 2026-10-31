// Retention for a folder of day folders, <dir>/<YYYY-MM-DD>/…, such as the
// telemetry FileTelemetry writes: a sweep that removes the day folders a
// policy no longer keeps, and a keeper that sweeps once a day, beside any
// other sweep of the day, such as the daemon's of run logs. And for the
// daemon's logs: daemon.log's daily rotations by age, daemon.out.log by size.
//
// A day is judged by the folder's name, a UTC day as FileTelemetry names
// them, never by its mtime, which an append to a late file or a copy moves.
// An entry whose name isn't a day is left alone and isn't counted.

import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";

import { rotatedLogPath } from "./daily-log.ts";

export type RetentionPolicy = {
  // A day folder older than this many days, by its name, is removed.
  readonly maxAgeDays: number;
  // Then the oldest go, never today's, while the day folders hold more than this.
  readonly maxBytes: number;
};

// What the daemon keeps of <home>/telemetry: 30 days, and at most 500 MB.
export const TELEMETRY_RETENTION: RetentionPolicy = {
  maxAgeDays: 30,
  maxBytes: 500 * 1024 * 1024,
};

const SWEEP_EVERY = "24 hours";

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const dayOf = (millis: number) => new Date(millis).toISOString().slice(0, 10);

// Whether `name` is a real day, as YYYY-MM-DD: 2026-02-30 isn't.
const isDay = (name: string) => {
  if (!DAY.test(name)) {
    return false;
  }

  const millis = Date.parse(`${name}T00:00:00Z`);

  return !Number.isNaN(millis) && dayOf(millis) === name;
};

// The bytes of the files under `folder`, at any depth.
const sizeOf = (folder: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let bytes = 0;

    for (const entry of yield* fs.readDirectory(folder, { recursive: true })) {
      const info = yield* fs.stat(`${folder}/${entry}`);

      if (info.type === "File") {
        bytes += Number(info.size);
      }
    }

    return bytes;
  });

// Removes the day folders under `dir` that `policy` doesn't keep: those older
// than its age, then the oldest while the rest hold more than its cap, never
// today's (UTC, by the clock). Answers with the days removed, oldest first. A
// `dir` that doesn't exist yet has nothing to remove.
export const sweepDayFolders = (
  dir: string,
  policy: RetentionPolicy,
): Effect.Effect<ReadonlyArray<string>, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    if (!(yield* fs.exists(dir))) {
      return [];
    }

    const now = yield* Clock.currentTimeMillis;
    const today = dayOf(now);
    const oldestKept = dayOf(now - policy.maxAgeDays * MILLIS_PER_DAY);
    const removed: Array<string> = [];

    const remove = (day: string) =>
      fs.remove(`${dir}/${day}`, { recursive: true }).pipe(
        Effect.tap(
          Effect.sync(() => {
            removed.push(day);
          }),
        ),
      );

    // ISO days sort as strings do, oldest first.
    const days = (yield* fs.readDirectory(dir)).filter(isDay).toSorted();
    const expired = days.filter((day) => day < oldestKept);
    const kept = days.filter((day) => day >= oldestKept);

    yield* Effect.forEach(expired, remove, { discard: true });

    const sizes = yield* Effect.forEach(kept, (day) => sizeOf(`${dir}/${day}`));
    let total = sizes.reduce((sum, bytes) => sum + bytes, 0);

    for (const [index, day] of kept.entries()) {
      if (total <= policy.maxBytes || day >= today) {
        break;
      }

      yield* remove(day);
      total -= sizes[index] ?? 0;
    }

    return removed;
  });

// What the daemon keeps of its own logs: rotations of daemon.log for 30 days,
// and daemon.out.log, the service manager's, up to 10 MB.
export const DAEMON_LOG_RETENTION = {
  maxAgeDays: 30,
  outLogMaxBytes: 10 * 1024 * 1024,
};

// The day in a rotated log's name, daemon.<day>.log, if it has one.
const ROTATED_DAY = /\.(\d{4}-\d{2}-\d{2})(\.[^.]*)?$/;

// Removes the rotations of the log at `log` (daily-log.ts names daemon.log's
// daemon.<YYYY-MM-DD>.log) older than `maxAgeDays`, judged by name, never the
// log itself. Answers with the file names removed, oldest first.
export const sweepRotatedLogs = (
  log: string,
  maxAgeDays: number,
): Effect.Effect<ReadonlyArray<string>, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = log.slice(0, log.lastIndexOf("/"));
    const name = log.slice(log.lastIndexOf("/") + 1);

    if (!(yield* fs.exists(dir))) {
      return [];
    }

    const oldestKept = dayOf((yield* Clock.currentTimeMillis) - maxAgeDays * MILLIS_PER_DAY);

    const expired = (yield* fs.readDirectory(dir))
      .filter((entry) =>
        Option.exists(
          Option.fromNullishOr(ROTATED_DAY.exec(entry)),
          ([, day = ""]) => isDay(day) && day < oldestKept && rotatedLogPath(name, day) === entry,
        ),
      )
      .toSorted();

    yield* Effect.forEach(expired, (entry) => fs.remove(`${dir}/${entry}`), { discard: true });

    return expired;
  });

// Empties the file at `path` once it holds more than `maxBytes`, in place, so
// a service manager appending to it keeps doing so. Answers whether it did.
export const capLog = (
  path: string,
  maxBytes: number,
): Effect.Effect<boolean, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    if (!(yield* fs.exists(path))) {
      return false;
    }

    if (Number((yield* fs.stat(path)).size) <= maxBytes) {
      return false;
    }

    yield* fs.truncate(path, 0);

    return true;
  });

// Where a keeper says what each sweep did: what it removed, or why it failed.
export type SweepReports<A = ReadonlyArray<string>, E = PlatformError> = {
  readonly swept: (removed: A) => Effect.Effect<void>;
  readonly failed: (cause: Cause.Cause<E>) => Effect.Effect<void>;
};

// A sweep that says what it did, to `reports`, and never fails: a failure,
// a defect among them, goes to `reports.failed`.
export const reported = <A, E, R>(
  sweep: Effect.Effect<A, E, R>,
  reports: SweepReports<A, E>,
): Effect.Effect<void, never, R> =>
  sweep.pipe(Effect.matchCauseEffect({ onSuccess: reports.swept, onFailure: reports.failed }));

// Runs the day's sweeps now and then once a day, for as long as it runs, each
// in turn: one reported sweep's failure never keeps the next from running,
// and the next day's tries it again.
export const daily = <R>(
  sweeps: ReadonlyArray<Effect.Effect<void, never, R>>,
): Effect.Effect<void, never, R> =>
  Effect.all(sweeps, { discard: true }).pipe(
    Effect.repeat(Schedule.fixed(SWEEP_EVERY)),
    Effect.asVoid,
  );

// Runs `sweep` now and then once a day, for as long as it runs. A failed
// sweep goes to `reports.failed`, and the next day's sweep tries again: it
// never fails or stops the keeper.
export const keepSweeping = <A, R>(
  sweep: Effect.Effect<A, PlatformError, R>,
  reports: SweepReports<A>,
): Effect.Effect<void, never, R> => daily([reported(sweep, reports)]);

// Sweeps `dir`'s day folders now and then once a day, as keepSweeping does.
export const keepDayFolders = (
  dir: string,
  policy: RetentionPolicy,
  reports: SweepReports,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  keepSweeping(sweepDayFolders(dir, policy), reports);
