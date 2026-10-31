// Retention for a folder of day folders, <dir>/<YYYY-MM-DD>/…, such as the
// telemetry FileTelemetry writes: a sweep that removes the day folders a
// policy no longer keeps, and a keeper that sweeps once a day, beside any
// other sweep of the day, such as the daemon's of run logs.
//
// A day is judged by the folder's name, a UTC day as FileTelemetry names
// them, never by its mtime, which an append to a late file or a copy moves.
// An entry whose name isn't a day is left alone and isn't counted.

import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";

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

// Sweeps `dir` now and then once a day, for as long as it runs. A failed
// sweep goes to `reports.failed`, and the next day's sweep tries again: it
// never fails or stops the keeper.
export const keepDayFolders = (
  dir: string,
  policy: RetentionPolicy,
  reports: SweepReports,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  daily([reported(sweepDayFolders(dir, policy), reports)]);
