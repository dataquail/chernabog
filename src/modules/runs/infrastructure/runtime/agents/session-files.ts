// The files of one interactive agent session, under
// <home>/sessions/interactive/<sessionId>/: what the launcher ran and the
// agent was asked, the answer the agent writes, and what the Stop hook decided.

import { ResolvedLauncher } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { Exec } from "../../../../../platform/exec.ts";
import { homePaths } from "../../../../../platform/home.ts";

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
  // Written by `chernabog open-pr --draft`: the pull request the person is asked to open.
  draft: `${dir}/draft.json`,
  // The HEAD the Stop hook last reminded the agent at to offer the pull request.
  reminded: `${dir}/reminded`,
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

// The launcher and handle a session runs under, when it started, whether
// a person works in it (AgentRequest.withPerson): such a session is never
// closed for a run that a stopped process left (ADR 23, #665), and the run
// that launched it, which the hub's session API checks a route's run
// against. A record from before it said says no person and no run.
export const LaunchRecord = Schema.fromJsonString(
  Schema.toCodecJson(
    Schema.Struct({
      launcher: ResolvedLauncher,
      handle: Schema.String,
      at: Schema.String,
      withPerson: Schema.optionalKey(Schema.Boolean),
      runId: Schema.optionalKey(Schema.String),
    }),
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

const Pid = Schema.fromJsonString(Schema.Int);

// Whether the `chernabog __launch` process of this session still runs, whatever
// its launcher says: a launcher can be wrong, and a second agent on one session
// and worktree is worse than waiting. A pid since reused by another process
// doesn't count, because only this session's launch runs with its spec.
export const launchRuns = (files: SessionFiles) =>
  Effect.gen(function* () {
    const pid = Option.flatMap(yield* readText(files.pid), (text) =>
      Schema.decodeOption(Pid)(text.trim()),
    );

    if (Option.isNone(pid)) {
      return false;
    }

    const ps = yield* (yield* Exec).run("ps", ["-o", "command=", "-p", String(pid.value)]);

    return ps.exitCode === 0 && ps.stdout.includes(files.spec);
  }).pipe(Effect.orElseSucceed(() => false));
