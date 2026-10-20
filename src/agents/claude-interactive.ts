// Claude Code as an ordinary interactive session under a launcher, never
// `claude -p`. The agent writes its answer to a file; a Stop hook marks the
// session done once that answer is valid. Meanwhile the transcript feeds the
// run log. A session still running when the daemon restarts is waited on
// again, never started twice.

import { createHash } from 'node:crypto';

import { AgentError, type AgentRequest, type AgentResult, type Json, parseJson, printJson } from '@chernabog/sdk';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';

import { claudeHomeOf, Home } from '../config.ts';
import { type Launcher, launcherFor } from '../launchers.ts';
import { shellCommand } from '../launchers/launcher.ts';
import { LaunchSpecJson } from '../launchers/shim.ts';
import { selfCommand } from '../self.ts';
import { type AdapterContext, promptFor, resumingOrStarting } from './adapter.ts';
import { claudeEnvironment, describeTranscriptLine, transcriptExists, transcriptFile } from './claude-events.ts';
import { Done, knownLaunch, LaunchRecord, readDecoded, readText, type SessionFiles, sessionFiles } from './session-files.ts';

const POLL = '2 seconds';

// Times a session may end without an answer and be resumed, before the call fails.
export const MAX_RESUMES = 2;

// Consecutive failures to ask the launcher about a session before it counts as gone.
const MAX_UNANSWERED = 30;

export const interactiveClaudeArgs = (request: AgentRequest, resuming: boolean, settingsFile: string) => {
  let session = ['--session-id', request.sessionId];

  if (resuming) session = ['--resume', request.sessionId];

  return [...session, '--permission-mode', 'auto', '--settings', settingsFile];
};

// Added here, not in the repo's prompts, so those stay the same under every launcher.
export const withAnswerFile = (prompt: string, files: SessionFiles, schema: Option.Option<Json>) => {
  const format = Option.match(schema, {
    onNone: () => 'as a JSON string',
    onSome: (json) => `as JSON matching this JSON Schema (also in ${files.schema}):\n\n\`\`\`json\n${printJson(json)}\n\`\`\`\n`,
  });

  return `${prompt}\n\n## Your final answer\n\nWhen you are finished, write your final answer to \`${files.answer}\` ${format}\nThen stop. Don't start background work after writing it.\n`;
};

const stopHookSettings = (files: SessionFiles) =>
  printJson({ hooks: { Stop: [{ hooks: [{ type: 'command', command: shellCommand([...selfCommand(), '__stop-hook', '--dir', files.dir]) }] }] } });

// Which call the session files belong to: a fix on the same session is a new call.
const callOf = (request: AgentRequest) =>
  createHash('sha256').update(request.prompt).update('\0').update(Option.getOrElse(request.resumePrompt, () => '')).digest('hex');

type Running = { readonly launcher: Launcher; readonly handle: string };

// The recorded session, if its launcher says it still runs.
const liveSession = (files: SessionFiles) =>
  Effect.gen(function* () {
    const record = yield* knownLaunch(files);

    if (Option.isNone(record)) return Option.none<Running>();

    const launcher = launcherFor(record.value.launcher);

    if (Option.isNone(launcher)) return Option.none<Running>();

    const alive = yield* launcher.value.alive(record.value.handle).pipe(Effect.orElseSucceed(() => false));

    return Option.liftPredicate({ launcher: launcher.value, handle: record.value.handle }, () => alive);
  });

const closeSession = (running: Running, log: AdapterContext['log']) =>
  running.launcher.close(running.handle).pipe(Effect.catch((error) => log(`claude: could not close ${running.launcher.name} session ${running.handle}: ${error.message}`)));

type Tail = { readonly read: Effect.Effect<void> };

// New lines of the transcript, read from where the last read stopped.
const transcriptTail = (file: string, log: AdapterContext['log']) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const sizeOf = fs.stat(file).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );

    let offset = yield* sizeOf;
    let partial = '';

    const read = Effect.gen(function* () {
      const size = yield* sizeOf;

      if (size <= offset) return;

      const bytes = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fs.open(file);
          yield* handle.seek(BigInt(offset), 'start');

          return yield* handle.readAlloc(size - offset);
        }),
      );

      offset = size;
      const lines = `${partial}${new TextDecoder().decode(Option.getOrElse(bytes, () => new Uint8Array()))}`.split('\n');
      partial = lines.pop() ?? '';

      for (const line of lines) yield* Option.match(describeTranscriptLine(line), { onNone: () => Effect.void, onSome: log });
    }).pipe(Effect.ignore);

    return { read } satisfies Tail;
  });

// Until the hook writes `done`, or the session is gone.
const waitForEnd = (files: SessionFiles, running: Running, tail: Tail, log: AdapterContext['log']) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let unanswered = 0;

    for (;;) {
      yield* tail.read;

      // The last of the transcript may have landed after the read above.
      if (yield* fs.exists(files.done)) return yield* tail.read;

      const alive = yield* Effect.result(running.launcher.alive(running.handle));

      if (Result.isFailure(alive)) {
        unanswered += 1;

        if (unanswered === 1) yield* log(`claude: ${running.launcher.name} isn't answering: ${alive.failure.message}`);

        if (unanswered >= MAX_UNANSWERED) return;
      } else if (alive.success) unanswered = 0;
      else return yield* tail.read;

      yield* Effect.sleep(POLL);
    }
  });

const start = (request: AgentRequest, context: AdapterContext, launcher: Launcher, files: SessionFiles, configDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const resuming = yield* transcriptExists(request, configDir);
    yield* fs.writeFileString(files.prompt, withAnswerFile(promptFor(request, resuming), files, request.outputSchema));
    yield* Option.match(request.outputSchema, { onNone: () => fs.remove(files.schema, { force: true }), onSome: (json) => fs.writeFileString(files.schema, printJson(json)) });
    yield* fs.writeFileString(files.settings, stopHookSettings(files));

    const spec = yield* Schema.encodeEffect(LaunchSpecJson)({
      command: 'claude',
      args: interactiveClaudeArgs(request, resuming, files.settings),
      cwd: request.cwd,
      env: claudeEnvironment(context),
      promptFile: files.prompt,
    });

    // The spec carries the session's environment, a token among it, so only its owner may read it;
    // chmod covers a spec an earlier run wrote before it was created this way.
    yield* fs.writeFileString(files.spec, spec, { mode: 0o600 });
    yield* fs.chmod(files.spec, 0o600);
    yield* context.log(`claude: ${resumingOrStarting(resuming)} session ${request.sessionId} in ${launcher.name}`);
    const handle = yield* launcher.start({ title: `chernabog-${request.sessionId.slice(0, 8)}`, cwd: request.cwd, command: [...selfCommand(), '__launch', files.spec] });
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* fs.writeFileString(files.launch, yield* Schema.encodeEffect(LaunchRecord)({ launcher: context.launcher, handle, at }));

    return { launcher, handle } satisfies Running;
  });

const finish = (request: AgentRequest, done: Done, files: SessionFiles, context: AdapterContext) =>
  Effect.gen(function* () {
    const running = yield* liveSession(files);

    if (Option.isSome(running)) yield* closeSession(running.value, context.log);

    if (!done.ok) return yield* new AgentError({ message: `claude: ${done.reason ?? 'no valid answer'}` });

    const answer = Option.flatMap(yield* readText(files.answer), parseJson);

    if (Option.isNone(answer)) return yield* new AgentError({ message: `claude: ${files.answer} is missing or not JSON` });

    return { sessionId: request.sessionId, output: answer.value, costUsd: Option.none<number>() } satisfies AgentResult;
  });

export const runInteractiveClaude = (request: AgentRequest, context: AdapterContext, launcher: Launcher) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;
    const files = sessionFiles(home.root, request.sessionId);
    const configDir = claudeHomeOf(context.account, home.user);
    yield* fs.makeDirectory(files.dir, { recursive: true });
    const call = callOf(request);

    // A new call on the session (a fix after an answer): the last one's session and files are finished with.
    if (!Option.contains(yield* readText(files.call), call)) {
      const previous = yield* liveSession(files);

      if (Option.isSome(previous)) yield* closeSession(previous.value, context.log);

      for (const file of [files.answer, files.done, files.blocks, files.launch]) yield* fs.remove(file, { force: true });

      yield* fs.writeFileString(files.call, call);
    }

    const tail = yield* transcriptTail(yield* transcriptFile(request, configDir), context.log);
    let starts = 0;

    for (;;) {
      const done = yield* readDecoded(Done, files.done);

      if (Option.isSome(done)) return yield* finish(request, done.value, files, context);

      const live = yield* liveSession(files);
      let running: Running;

      if (Option.isSome(live)) {
        yield* context.log(`claude: session ${request.sessionId} is still running in ${live.value.launcher.name}; waiting on it`);
        running = live.value;
      } else if (starts > MAX_RESUMES) return yield* new AgentError({ message: `claude: the session ended ${starts} times without an answer` });
      else {
        running = yield* start(request, context, launcher, files, configDir);
        starts += 1;
      }

      yield* waitForEnd(files, running, tail, context.log);
    }
  }).pipe(
    Effect.catchTags({
      LaunchError: (error) => Effect.fail(new AgentError({ message: `${error.launcher}: ${error.message}` })),
      PlatformError: (error) => Effect.fail(new AgentError({ message: `claude: ${error.message}` })),
      SchemaError: (error) => Effect.fail(new AgentError({ message: `claude: ${error.message}` })),
    }),
  );
