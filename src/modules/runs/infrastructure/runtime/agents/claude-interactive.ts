// Claude Code as an ordinary interactive session under a launcher, never
// `claude -p`. The session reaches its hub's session API (ADR 24): the agent
// sends its answer to the answer route, and Claude's Stop hook, an HTTP hook
// on the stop route, marks the session done once that answer is valid. A
// hook needs nothing from the `chernabog` binary. Meanwhile the transcript
// feeds the run log. A session still running when the daemon restarts is
// waited on again, never started twice.

import { createHash } from "node:crypto";

import {
  AgentError,
  type AgentRequest,
  type AgentResult,
  type Json,
  parseJson,
  printJson,
  Run,
} from "@chernabog/core";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { claudeHomeOf } from "../../../../../platform/agent-accounts.ts";
import { type Environment } from "../../../../../platform/environment.ts";
import { Home } from "../../../../../platform/home.ts";
import { selfCommand } from "../../../../../platform/self.ts";
import {
  SESSION_TOKEN_ENV,
  SESSION_URL_ENV,
  type SessionEndpoint,
} from "../../../../../platform/session-api-access.ts";
import { type Launcher, launcherFor } from "../launchers.ts";
import { shellCommand } from "../launchers/launcher.ts";
import { LaunchSpecJson } from "../launchers/shim.ts";
import { type AdapterContext, promptFor, resumingOrStarting } from "./adapter.ts";
import {
  claudeEnvironment,
  describeTranscriptLine,
  transcriptExists,
  transcriptFile,
} from "./claude-events.ts";
import { sandboxedLaunch } from "./claude-sandbox.ts";
import {
  Done,
  knownLaunch,
  LaunchRecord,
  launchRuns,
  readDecoded,
  readText,
  SESSION_ENV,
  type SessionFiles,
  sessionFiles,
} from "./session-files.ts";

const POLL = "2 seconds";

// Times a session may end without an answer and be resumed, before the call fails.
export const MAX_RESUMES = 2;

// Consecutive failures to ask the launcher about a session before it counts as gone.
const MAX_UNANSWERED = 30;

// How long a launch has to bring up `chernabog __launch`, which records its
// pid, before a launcher saying the session ended is believed without it.
const STARTUP = Duration.seconds(30);

export const interactiveClaudeArgs = (
  request: AgentRequest,
  resuming: boolean,
  settingsFile: string,
) => {
  let session = ["--session-id", request.sessionId];

  if (resuming) {
    session = ["--resume", request.sessionId];
  }

  return [...session, "--permission-mode", "auto", "--settings", settingsFile];
};

// What a session with a person adds: whatever the prompt says about working
// unattended, the person decides with the agent, and chernabog is at hand.
const personNote = () =>
  [
    "## A person is here",
    "",
    "A person is working in this session with you. Where this prompt says you are unattended, that doesn't hold: talk it over with them, ask what you need to, and decide together. Stopping to wait for them is fine.",
    "",
    `To run \`chernabog\` from here, use \`${shellCommand(selfCommand())}\`.`,
    "",
  ].join("\n");

// How the agent sends its answer: a PUT to its session's answer route, with
// the URL and token its environment carries, so neither is in the prompt.
// curl fails, printing the hub's reason, when the answer doesn't match.
export const answerCommand = (placeholder: string) =>
  [
    "```sh",
    `curl -sS --fail-with-body -X PUT "$${SESSION_URL_ENV}/answer" -H "Authorization: Bearer $${SESSION_TOKEN_ENV}" -H 'Content-Type: application/json' --data-binary @- <<'ANSWER'`,
    placeholder,
    "ANSWER",
    "```",
  ].join("\n");

export const ANSWER_PLACEHOLDER = "<your answer, as JSON>";

// Added here, not in the repo's prompts, so those stay the same under every launcher.
export const withAnswerFile = (prompt: string, schema: Option.Option<Json>, withPerson = false) => {
  const format = Option.match(schema, {
    onNone: () => "as a JSON string",
    onSome: (json) =>
      `as JSON matching this JSON Schema:\n\n\`\`\`json\n${printJson(json)}\n\`\`\`\n`,
  });

  const send = `Send it to chernabog with this command, the JSON in place of \`${ANSWER_PLACEHOLDER}\`:\n\n${answerCommand(ANSWER_PLACEHOLDER)}\n\nIf it fails, it says why: fix the answer and send it again.`;

  if (withPerson) {
    return `${prompt}\n\n${personNote()}\n## Your final answer\n\nOnce the two of you agree you are finished, your final answer goes to chernabog ${format}\nWhere this prompt names a command that records it, run that. Otherwise: ${send}\nUntil then, keep working with the person.\n`;
  }

  return `${prompt}\n\n## Your final answer\n\nWhen you are finished, send your final answer ${format}\n${send}\nThen stop. Don't start background work after sending it.\n`;
};

// Longer than the stop route's git checks take.
const HOOK_TIMEOUT_SECONDS = 120;

// Claude Code's HTTP hook on one of the session's routes: it POSTs the
// hook's input there and reads the hook's output from the reply. The token
// is interpolated into the header from the session's env, never written down.
const hook = (url: string, route: string) => ({
  type: "http",
  url: `${url}/${route}`,
  headers: { Authorization: `Bearer $${SESSION_TOKEN_ENV}` },
  allowedEnvVars: [SESSION_TOKEN_ENV],
  timeout: HOOK_TIMEOUT_SECONDS,
});

// The session's settings: its Stop hook on the stop route, and with a person
// its AskUserQuestion hooks on the question route. Whether a person is in the
// session the hub reads from its launch record, never from the request.
export const sessionSettings = (url: string, withPerson: boolean) => {
  const stop = [{ hooks: [hook(url, "stop")] }];

  if (!withPerson) {
    return printJson({ hooks: { Stop: stop } });
  }

  const question = [{ matcher: "AskUserQuestion", hooks: [hook(url, "question")] }];

  return printJson({ hooks: { Stop: stop, PreToolUse: question, PostToolUse: question } });
};

// Which call the session files belong to: a fix on the same session is a new call.
const callOf = (request: AgentRequest) =>
  createHash("sha256")
    .update(request.prompt)
    .update("\0")
    .update(Option.getOrElse(request.resumePrompt, () => ""))
    .digest("hex");

type Running = { readonly launcher: Launcher; readonly handle: string };

// The recorded session, if its launcher says it still runs.
const liveSession = (files: SessionFiles) =>
  Effect.gen(function* () {
    const record = yield* knownLaunch(files);

    if (Option.isNone(record)) {
      return Option.none<Running>();
    }

    const launcher = launcherFor(record.value.launcher);

    if (Option.isNone(launcher)) {
      return Option.none<Running>();
    }

    const alive =
      (yield* launcher.value.alive(record.value.handle).pipe(Effect.orElseSucceed(() => false))) ||
      (yield* launchRuns(files));

    return Option.liftPredicate(
      { launcher: launcher.value, handle: record.value.handle },
      () => alive,
    );
  });

const closeSession = (running: Running, log: AdapterContext["log"]) =>
  running.launcher
    .close(running.handle)
    .pipe(
      Effect.catch((error) =>
        log(
          `claude: could not close ${running.launcher.name} session ${running.handle}: ${error.message}`,
        ),
      ),
    );

type Tail = { readonly read: Effect.Effect<void> };

// New lines of the transcript, read from where the last read stopped.
const transcriptTail = (file: string, log: AdapterContext["log"]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const sizeOf = fs.stat(file).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );

    let offset = yield* sizeOf;
    let partial = "";

    const read = Effect.gen(function* () {
      const size = yield* sizeOf;

      if (size <= offset) {
        return;
      }

      const bytes = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fs.open(file);
          yield* handle.seek(BigInt(offset), "start");

          return yield* handle.readAlloc(size - offset);
        }),
      );

      offset = size;

      const lines =
        `${partial}${new TextDecoder().decode(Option.getOrElse(bytes, () => new Uint8Array()))}`.split(
          "\n",
        );

      partial = lines.pop() ?? "";

      for (const line of lines) {
        yield* Option.match(describeTranscriptLine(line), {
          onNone: () => Effect.void,
          onSome: log,
        });
      }
    }).pipe(Effect.ignore);

    return { read } satisfies Tail;
  });

// Until the hook writes `done`, or the session is gone.
const waitForEnd = (
  files: SessionFiles,
  running: Running,
  tail: Tail,
  log: AdapterContext["log"],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let unanswered = 0;
    let disagreed = false;
    const since = yield* DateTime.now;

    // A launch whose process hasn't recorded its pid yet, within STARTUP.
    const comingUp = Effect.gen(function* () {
      if (yield* fs.exists(files.pid)) {
        return false;
      }

      return Duration.isLessThan(DateTime.distance(since, yield* DateTime.now), STARTUP);
    });

    for (;;) {
      yield* tail.read;

      // The last of the transcript may have landed after the read above.
      if (yield* fs.exists(files.done)) {
        return yield* tail.read;
      }

      const alive = yield* Effect.result(running.launcher.alive(running.handle));

      if (Result.isFailure(alive)) {
        unanswered += 1;

        if (unanswered === 1) {
          yield* log(`claude: ${running.launcher.name} isn't answering: ${alive.failure.message}`);
        }

        if (unanswered >= MAX_UNANSWERED && !(yield* launchRuns(files))) {
          return;
        }
      } else if (alive.success || (yield* comingUp)) {
        unanswered = 0;
      } else if (yield* launchRuns(files)) {
        if (!disagreed) {
          yield* log(
            `claude: ${running.launcher.name} says the session ended, but its process still runs; waiting on it`,
          );
        }

        disagreed = true;
      } else {
        return yield* tail.read;
      }

      yield* Effect.sleep(POLL);
    }
  });

// Its own routes' URL and token, and with a person its directory, which
// `chernabog open-pr` finds it by until it too goes through the API (#715).
const sessionEnv = (
  files: SessionFiles,
  endpoint: SessionEndpoint,
  withPerson: boolean,
): Environment => {
  const routes = { [SESSION_URL_ENV]: endpoint.url, [SESSION_TOKEN_ENV]: endpoint.token };

  if (!withPerson) {
    return routes;
  }

  return { ...routes, [SESSION_ENV]: files.dir };
};

const start = (
  request: AgentRequest,
  context: AdapterContext,
  launcher: Launcher,
  files: SessionFiles,
  configDir: string,
  endpoint: SessionEndpoint,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const resuming = yield* transcriptExists(request, configDir);
    const withPerson = request.withPerson === true;
    yield* fs.writeFileString(
      files.prompt,
      withAnswerFile(promptFor(request, resuming), request.outputSchema, withPerson),
    );
    yield* Option.match(request.outputSchema, {
      onNone: () => fs.remove(files.schema, { force: true }),
      onSome: (json) => fs.writeFileString(files.schema, printJson(json)),
    });
    yield* fs.writeFileString(files.settings, sessionSettings(endpoint.url, withPerson));

    // In a container, the session's environment and mounts are its own (ADR 24).
    let inContainer = Option.none<Effect.Success<ReturnType<typeof sandboxedLaunch>>>();

    if (context.sandbox.name !== "none") {
      inContainer = Option.some(yield* sandboxedLaunch(request, context, files));
    }

    const env = Option.match(inContainer, {
      onNone: () => claudeEnvironment(context),
      onSome: (launch) => launch.env,
    });

    const spec = yield* Schema.encodeEffect(LaunchSpecJson)({
      command: "claude",
      args: interactiveClaudeArgs(request, resuming, files.settings),
      cwd: request.cwd,
      env: { ...env, ...sessionEnv(files, endpoint, withPerson) },
      promptFile: files.prompt,
      pidFile: files.pid,
      sandbox: context.sandbox.name,
      ...Option.match(inContainer, {
        onNone: () => ({}),
        onSome: (launch) => ({ container: launch.container }),
      }),
    });

    // The spec carries the session's environment, a token among it, so only its owner may read it;
    // chmod covers a spec an earlier run wrote before it was created this way.
    yield* fs.writeFileString(files.spec, spec, { mode: 0o600 });
    yield* fs.chmod(files.spec, 0o600);
    yield* context.log(
      `claude: ${resumingOrStarting(resuming)} session ${request.sessionId} in ${launcher.name}`,
    );

    const handle = yield* launcher.start({
      title: `chernabog-${request.sessionId.slice(0, 8)}`,
      cwd: request.cwd,
      command: [...selfCommand(), "__launch", files.spec],
      log: context.log,
    });

    const at = DateTime.formatIso(yield* DateTime.now);
    const run = yield* Effect.serviceOption(Run);
    yield* fs.writeFileString(
      files.launch,
      yield* Schema.encodeEffect(LaunchRecord)({
        launcher: context.launcher,
        handle,
        at,
        withPerson: request.withPerson === true,
        ...Option.match(run, { onNone: () => ({}), onSome: ({ runId }) => ({ runId }) }),
      }),
    );

    return { launcher, handle } satisfies Running;
  });

// A session with a person stays open for them to close; the next call on it closes it first.
const finish = (request: AgentRequest, done: Done, files: SessionFiles, context: AdapterContext) =>
  Effect.gen(function* () {
    const running = Option.filter(yield* liveSession(files), () => request.withPerson !== true);

    if (Option.isSome(running)) {
      yield* closeSession(running.value, context.log);
    }

    if (!done.ok) {
      return yield* new AgentError({ message: `claude: ${done.reason ?? "no valid answer"}` });
    }

    const answer = Option.flatMap(yield* readText(files.answer), parseJson);

    if (Option.isNone(answer)) {
      return yield* new AgentError({ message: `claude: ${files.answer} is missing or not JSON` });
    }

    return {
      sessionId: request.sessionId,
      output: answer.value,
      costUsd: Option.none<number>(),
    } satisfies AgentResult;
  });

export const runInteractiveClaude = (
  request: AgentRequest,
  context: AdapterContext,
  launcher: Launcher,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;

    // Without its hub's session API, a session could never say it is done.
    const endpoint = yield* Effect.fromOption(context.sessionApi).pipe(
      Effect.mapError(
        () =>
          new AgentError({
            message:
              "claude: an interactive session reaches chernabog through its hub's session API, which this process doesn't have; the hub's log says why it didn't open",
          }),
      ),
    );

    const files = sessionFiles(home.root, request.sessionId);

    // A sandboxed session keeps its transcripts in its own config dir, mounted into its container.
    const configDir = Option.match(
      Option.liftPredicate(context.sandbox, ({ name }) => name !== "none"),
      { onNone: () => claudeHomeOf(context.account, home.user), onSome: () => files.claude },
    );

    yield* fs.makeDirectory(files.dir, { recursive: true });
    const call = callOf(request);

    // A new call on the session (a fix after an answer): the last one's session and files are finished with.
    if (!Option.contains(yield* readText(files.call), call)) {
      const previous = yield* liveSession(files);

      if (Option.isSome(previous)) {
        yield* closeSession(previous.value, context.log);
      }

      for (const file of [
        files.answer,
        files.done,
        files.blocks,
        files.draft,
        files.reminded,
        files.launch,
      ]) {
        yield* fs.remove(file, { force: true });
      }

      yield* fs.writeFileString(files.call, call);
    }

    const tail = yield* transcriptTail(yield* transcriptFile(request, configDir), context.log);
    let starts = 0;

    for (;;) {
      const done = yield* readDecoded(Done, files.done);

      if (Option.isSome(done)) {
        return yield* finish(request, done.value, files, context);
      }

      let live = yield* liveSession(files);
      let running: Running;

      // A session an earlier run of this call left running reaches that
      // run's routes, which refuse it now: it could never finish. It is
      // closed, and resumed below with this run's.
      for (const left of Option.toArray(live)) {
        const settings = sessionSettings(endpoint.url, request.withPerson === true);

        if (!Option.contains(yield* readText(files.settings), settings)) {
          yield* context.log(
            `claude: session ${request.sessionId} reaches an earlier run's session API; closing it to resume it under this run`,
          );
          yield* closeSession(left, context.log);
          live = Option.none();
        }
      }

      if (Option.isSome(live)) {
        yield* context.log(
          `claude: session ${request.sessionId} is still running in ${live.value.launcher.name}; waiting on it`,
        );
        running = live.value;
      } else if (request.withPerson === true && starts > 0) {
        // The person closed the session this call opened: reopening it is
        // theirs, with chernabog start again. (After a daemon restart, starts
        // counts from zero, so a session closed while it was down opens once.)
        return yield* new AgentError({
          message: "claude: the person closed the session before it finished",
        });
      } else if (starts > MAX_RESUMES) {
        return yield* new AgentError({
          message: `claude: the session ended ${starts} times without an answer`,
        });
      } else {
        running = yield* start(request, context, launcher, files, configDir, endpoint);
        starts += 1;
      }

      yield* waitForEnd(files, running, tail, context.log);
    }
  }).pipe(
    Effect.catchTags({
      LaunchError: (error) =>
        Effect.fail(new AgentError({ message: `${error.launcher}: ${error.message}` })),
      PlatformError: (error) =>
        Effect.fail(new AgentError({ message: `claude: ${error.message}` })),
      SchemaError: (error) => Effect.fail(new AgentError({ message: `claude: ${error.message}` })),
    }),
  );
