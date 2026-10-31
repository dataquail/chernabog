// Retention for a folder of day folders (<dir>/<YYYY-MM-DD>/…), such as the
// telemetry FileTelemetry writes.

import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";

export type RetentionPolicy = {
  // A day folder older than this many days, by its name, is removed.
  readonly maxAgeDays: number;
  // Then the oldest go, never today's, while the day folders hold more than this.
  readonly maxBytes: number;
};

export const sweepDayFolders = (
  _dir: string,
  _policy: RetentionPolicy,
): Effect.Effect<ReadonlyArray<string>, PlatformError, FileSystem.FileSystem> => Effect.succeed([]);

export type SweepReports = {
  readonly swept: (removed: ReadonlyArray<string>) => Effect.Effect<void>;
  readonly failed: (cause: Cause.Cause<PlatformError>) => Effect.Effect<void>;
};

export const keepDayFolders = (
  _dir: string,
  _policy: RetentionPolicy,
  _reports: SweepReports,
): Effect.Effect<never, never, FileSystem.FileSystem> => Effect.never;
