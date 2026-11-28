// Codex, headless: `codex exec --json` with automatic approval review inside a
// workspace sandbox, --output-schema for the answer, and its own thread ids,
// which are recorded the moment Codex reports them. What a thread spent is
// read from its session file (codex-token-usage.ts). In a repo with a
// sandbox, it runs in the repo's container instead (codex-sandbox.ts).

import { AgentError, printJson } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { codexHomeOf } from "../../../../../platform/agent-accounts.ts";
import { Exec } from "../../../../../platform/exec.ts";
import { Home } from "../../../../../platform/home.ts";
import { type Adapter, agentEnvironment, answerFrom, promptFor } from "./adapter.ts";
import { sandboxedCodex } from "./codex-sandbox.ts";
import { readCodexTokenUsage } from "./codex-token-usage.ts";
import { clip, runAgentProcess } from "./process.ts";
import { sessionFiles } from "./session-files.ts";
import { knownSession, rememberSession } from "./sessions.ts";

export type CodexRun = {
  readonly thread: Option.Option<string>;
  readonly schemaFile: Option.Option<string>;
  readonly lastFile: string;
  readonly writableRoots: ReadonlyArray<string>;
  // In the repo's container, which is the sandbox (ADR 24, decision 4).
  readonly inContainer: boolean;
};

const writableRootsArgs = (roots: ReadonlyArray<string>) => {
  if (roots.length === 0) {
    return [];
  }

  return ["-c", `sandbox_workspace_write.writable_roots=${printJson(roots)}`];
};

// Codex's workspace sandbox needs what a container's default profile denies
// (Landlock and seccomp on Linux, user namespaces), so nested in one it fails
// the commands it runs. In a container it is off: the container is the
// sandbox, and holds the worktree, the common git dir and the session's own
// files, nothing else of the home.
const sandboxArgs = (run: CodexRun) => {
  if (run.inContainer) {
    return ["-c", 'sandbox_mode="danger-full-access"'];
  }

  return [
    "-c",
    'sandbox_mode="workspace-write"',
    "-c",
    "sandbox_workspace_write.network_access=true",
    ...writableRootsArgs(run.writableRoots),
  ];
};

export const codexArgs = (run: CodexRun) => [
  "exec",
  ...Option.match(run.thread, {
    onNone: () => ["--approve-for-me"],
    onSome: (thread) => ["resume", thread],
  }),
  "--json",
  ...sandboxArgs(run),
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
  usage: readCodexTokenUsage,
  run: (request, context) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* Home;
      const known = yield* knownSession("codex", request.sessionId);
      const files = sessionFiles(home.root, request.sessionId);

      const runtime = Option.filter(
        Option.some(context.sandbox.name),
        (name): name is "docker" | "podman" => name !== "none",
      );

      // A sandboxed call's files sit in its session dir, which its container mounts.
      if (Option.isSome(runtime)) {
        yield* fs.makeDirectory(files.dir, { recursive: true });
      }

      const scratch = yield* fs.makeTempDirectoryScoped(
        Option.match(runtime, {
          onNone: () => ({ prefix: "chernabog-codex-" }),
          onSome: () => ({ directory: files.dir, prefix: "codex-call-" }),
        }),
      );

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

      const launched = yield* Option.match(runtime, {
        onNone: () =>
          Effect.succeed({
            command: "codex",
            args: codexArgs({
              thread: known,
              schemaFile,
              lastFile,
              writableRoots,
              inContainer: false,
            }),
            env: agentEnvironment(
              context,
              { CODEX_HOME: codexHomeOf(context.account, home.user) },
              ["CLAUDE_CONFIG_DIR"],
            ),
            settle: Effect.void,
          }),
        onSome: (name) =>
          sandboxedCodex(
            name,
            request,
            context,
            files,
            scratch,
            codexArgs({
              thread: known,
              schemaFile,
              lastFile,
              writableRoots: [],
              inContainer: true,
            }),
          ),
      });

      if (Option.isSome(runtime)) {
        yield* context.log(`codex: in sandbox ${context.sandbox.name}`);
      }

      const finished = yield* runAgentProcess(
        {
          command: launched.command,
          args: launched.args,
          cwd: request.cwd,
          env: launched.env,
          stdin: promptFor(request, Option.isSome(known)),
        },
        onLine,
      ).pipe(Effect.ensuring(launched.settle));

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
