// `chernabog __launch <spec.json>`: the one short command a launcher runs. It
// starts the agent in the foreground on the terminal, with exactly the
// environment in the spec and the prompt read from a file, so a long prompt
// never passes through a shell or tmux's quoting, and every launcher gives the
// agent the same environment.

import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';
import * as Schema from 'effect/Schema';

export const LaunchSpecFile = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
  // Read and passed as the last argument.
  promptFile: Schema.optionalKey(Schema.String),
});

export type LaunchSpecFile = typeof LaunchSpecFile.Type;

export const LaunchSpecJson = Schema.fromJsonString(LaunchSpecFile);

export const runLaunch = (specFile: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spec = yield* Schema.decodeEffect(LaunchSpecJson)(yield* fs.readFileString(specFile));
    const prompt = yield* Effect.forEach(Option.toArray(Option.fromUndefinedOr(spec.promptFile)), (file) => fs.readFileString(file));

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    // Not detached: the agent keeps this terminal as its controlling one, so it
    // gets resizes, and closing the terminal hangs it up.
    const agent = ChildProcess.make(spec.command, [...spec.args, ...prompt], {
      cwd: spec.cwd,
      env: spec.env,
      extendEnv: false,
      detached: false,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      forceKillAfter: '5 seconds',
    });

    const exitCode = yield* spawner.spawn(agent).pipe(
      Effect.flatMap((handle) => handle.exitCode),
      Effect.scoped,
    );

    return Number(exitCode);
  });
