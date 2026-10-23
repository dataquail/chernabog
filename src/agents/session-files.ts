// The files of one interactive agent session, under
// <home>/sessions/interactive/<sessionId>/: what the launcher ran and the
// agent was asked, the answer the agent writes, and what the Stop hook decided.

import { ResolvedLauncher } from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { homePaths } from "../config.ts";

export const sessionFilesIn = (dir: string) => ({
  dir,
  prompt: `${dir}/prompt.md`,
  spec: `${dir}/spec.json`,
  settings: `${dir}/settings.json`,
  schema: `${dir}/schema.json`,
  // Written by the agent.
  answer: `${dir}/answer.json`,
  // Written by the Stop hook, once the answer is valid or it gave up.
  done: `${dir}/done`,
  // How many times the hook has sent the agent back.
  blocks: `${dir}/blocks`,
  // Which call the files belong to: a hash of its prompt.
  call: `${dir}/call`,
  // The launcher and handle the session runs under.
  launch: `${dir}/launch.json`,
  // Written by `chernabog __launch`: its pid, while the agent runs.
  pid: `${dir}/agent.pid`,
});

export type SessionFiles = ReturnType<typeof sessionFilesIn>;

// Names a session with a person's directory in its environment, for `chernabog open-pr`.
export const SESSION_ENV = "CHERNABOG_SESSION";

export const sessionFiles = (root: string, sessionId: string) =>
  sessionFilesIn(`${homePaths(root).sessions}/interactive/${sessionId}`);

export const Done = Schema.fromJsonString(
  Schema.Struct({ ok: Schema.Boolean, reason: Schema.optionalKey(Schema.String) }),
);

export type Done = typeof Done.Type;

export const LaunchRecord = Schema.fromJsonString(
  Schema.toCodecJson(
    Schema.Struct({ launcher: ResolvedLauncher, handle: Schema.String, at: Schema.String }),
  ),
);

export type LaunchRecord = typeof LaunchRecord.Type;

// A file decoded with a schema; none when it is absent or unreadable.
export const readDecoded = <A>(schema: Schema.Codec<A, string>, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    if (!(yield* fs.exists(file))) {
      return Option.none<A>();
    }

    return Schema.decodeOption(schema)(yield* fs.readFileString(file));
  }).pipe(Effect.orElseSucceed(() => Option.none<A>()));

export const readText = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    if (!(yield* fs.exists(file))) {
      return Option.none<string>();
    }

    return Option.some(yield* fs.readFileString(file));
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

export const knownLaunch = (files: SessionFiles) => readDecoded(LaunchRecord, files.launch);
