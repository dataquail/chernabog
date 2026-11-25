// The hub's session API (ADR 24). Not built yet: it refuses to open.

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Scope from "effect/Scope";

import type { Exec } from "../../platform/exec.ts";

export type SessionApiOptions = {
  readonly root: string;
  readonly isLive: (runId: string) => Effect.Effect<boolean>;
  readonly log: (line: string) => Effect.Effect<void>;
  readonly gateways: ReadonlyArray<string>;
};

export type SessionApi = {
  readonly port: number;
  readonly hosts: ReadonlyArray<string>;
  readonly runKey: (runId: string) => Uint8Array;
};

export const openSessionApi = (
  _options: SessionApiOptions,
): Effect.Effect<SessionApi, never, FileSystem.FileSystem | Exec | Scope.Scope> =>
  Effect.die("the session API isn't built yet");
