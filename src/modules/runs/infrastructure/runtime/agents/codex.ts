// Codex, headless: `codex exec --json` with automatic approval review inside a
// workspace sandbox, --output-schema for the answer, and its own thread ids,
// which are recorded the moment Codex reports them.

import { AgentError, printJson } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { codexHomeOf } from "../../../../../platform/agent-accounts.ts";
import { Exec } from "../../../../../platform/exec.ts";
import { Home } from "../../../../../platform/home.ts";
import { type Adapter, agentEnvironment, answerFrom, promptFor } from "./adapter.ts";
import { clip, runAgentProcess } from "./process.ts";
import { knownSession, rememberSession } from "./sessions.ts";

export type CodexRun = {
  readonly thread: Option.Option<string>;
  readonly schemaFile: Option.Option<string>;
  readonly lastFile: string;
  readonly writableRoots: ReadonlyArray<string>;
};

const writableRootsArgs = (roots: ReadonlyArray<string>) => {
  if (roots.length === 0) {
    return [];
  }

  return ["-c", `sandbox_workspace_write.writable_roots=${printJson(roots)}`];
};

export const codexArgs = (run: CodexRun) => [
  "exec",
  ...Option.match(run.thread, {
    onNone: () => ["--approve-for-me"],
    onSome: (thread) => ["resume", thread],
  }),
  "--json",
  "-c",
  'sandbox_mode="workspace-write"',
  "-c",
  "sandbox_workspace_write.network_access=true",
  ...writableRootsArgs(run.writableRoots),
  ...Option.match(run.schemaFile, {
    onNone: () => [],
    onSome: (file) => ["--output-schema", file],
  }),
  "-o",
  run.lastFile,
  "-",
];

const Item = Schema.Struct({
  type: Schema.String,
  command: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  changes: Schema.optionalKey(Schema.Array(Schema.Struct({ path: Schema.String }))),
});

export const CodexEvent = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    thread_id: Schema.optionalKey(Schema.String),
    item: Schema.optionalKey(Item),
    error: Schema.optionalKey(Schema.Json),
  }),
);

export type CodexEvent = typeof CodexEvent.Type;

const describeItem = (event: CodexEvent, item: typeof Item.Type) => {
  if (event.type === "item.started" && item.type === "command_execution") {
    return Option.some(`$ ${clip(item.command ?? "", 160)}`);
  }

  if (event.type !== "item.completed") {
    return Option.none<string>();
  }

  if (item.type === "agent_message") {
    return Option.some(clip((item.text ?? "").replace(/\s+/g, " ")));
  }

  if (item.type === "file_change") {
    return Option.some(`edited ${(item.changes ?? []).map((change) => change.path).join(", ")}`);
  }

  return Option.none<string>();
};

export const isFailure = (event: CodexEvent) =>
  event.type === "turn.failed" || event.type === "error";

export const describeCodexEvent = (event: CodexEvent) => {
  if (isFailure(event)) {
    return Option.some(`codex: ${clip(printJson(event.error ?? event.type))}`);
  }

  return Option.flatMap(Option.fromUndefinedOr(event.item), (item) => describeItem(event, item));
};

// A worktree's git data lives in its main checkout's .git, outside the
// worktree: the sandbox must let the agent write there to commit.
const gitCommonDir = (cwd: string) =>
  Exec.use((exec) =>
    exec.run("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ).pipe(
    Effect.map((result) => Option.liftPredicate(result.stdout.trim(), () => result.exitCode === 0)),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

export const codexAdapter: Adapter = {
  name: "codex",
  run: (request, context) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* Home;
      const known = yield* knownSession("codex", request.sessionId);
      const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-codex-" });
      const schemaFile = Option.map(request.outputSchema, () => `${scratch}/schema.json`);
      const lastFile = `${scratch}/last-message.txt`;

      if (Option.isSome(request.outputSchema)) {
        yield* fs.writeFileString(`${scratch}/schema.json`, printJson(request.outputSchema.value));
      }

      yield* context.log(
        Option.match(known, {
          onNone: () => `codex: starting a thread for ${request.sessionId}`,
          onSome: (thread) => `codex: resuming thread ${thread} for ${request.sessionId}`,
        }),
      );

      let thread = known;
      let failure = Option.none<string>();
      const writableRoots = Option.toArray(yield* gitCommonDir(request.cwd));

      const onLine = (line: string) =>
        Option.match(Schema.decodeOption(CodexEvent)(line), {
          onNone: () => context.log(clip(line)),
          onSome: (event) =>
            Effect.gen(function* () {
              const started = Option.fromUndefinedOr(event.thread_id);

              if (
                event.type === "thread.started" &&
                Option.isNone(thread) &&
                Option.isSome(started)
              ) {
                thread = started;
                yield* rememberSession("codex", request.sessionId, started.value);
              }

              if (isFailure(event)) {
                failure = Option.some(printJson(event.error ?? event.type));
              }

              yield* Option.match(describeCodexEvent(event), {
                onNone: () => Effect.void,
                onSome: context.log,
              });
            }),
        });

      const env = agentEnvironment(
        context,
        { CODEX_HOME: codexHomeOf(context.account, home.user) },
        ["CLAUDE_CONFIG_DIR"],
      );

      const args = codexArgs({ thread: known, schemaFile, lastFile, writableRoots });

      const finished = yield* runAgentProcess(
        {
          command: "codex",
          args,
          cwd: request.cwd,
          env,
          stdin: promptFor(request, Option.isSome(known)),
        },
        onLine,
      );

      let last = "";

      if (yield* fs.exists(lastFile)) {
        last = yield* fs.readFileString(lastFile);
      }

      if (finished.exitCode !== 0 || Option.isSome(failure)) {
        return yield* new AgentError({
          message: `codex exited ${finished.exitCode}: ${clip(
            Option.getOrElse(failure, () => finished.stderr),
            2000,
          )}`,
        });
      }

      return {
        sessionId: Option.getOrElse(thread, () => request.sessionId),
        output: answerFrom(last, request.outputSchema),
        costUsd: Option.none<number>(),
      };
    }).pipe(
      Effect.scoped,
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(new AgentError({ message: `codex: ${error.message}` })),
      ),
    ),
};
