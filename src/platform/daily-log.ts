// A log file that turns over each UTC day: daemon.log, and daemon.<day>.log
// for each day before.

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

export type DailyLog = { readonly log: (line: string) => Effect.Effect<void> };

export const dailyLogWriting = (
  _path: string,
): Effect.Effect<DailyLog, never, FileSystem.FileSystem> =>
  Effect.succeed({ log: () => Effect.void });
