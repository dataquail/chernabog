// Spans and logs, appended to day-sharded JSONL files. Not written yet.

import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

export type FileTelemetryOptions = {
  readonly dir: string;
  readonly process: "daemon" | "cli";
  readonly warn?: (line: string) => void;
};

export const FileTelemetry = {
  layer: (_options: FileTelemetryOptions): Layer.Layer<never, never, FileSystem.FileSystem> =>
    Layer.empty,
};
