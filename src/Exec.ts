// Runs other programs (gh, git, claude, security) and collects what they
// print. A service, so tests can answer for a program without running it.

import * as Context from 'effect/Context';
import type * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';

import type { Environment } from './platform/environment.ts';

export type ExecOptions = {
  readonly cwd?: string;
  // The child's whole environment; without it, the child inherits this process's.
  readonly env?: Environment;
  readonly stdin?: string;
  readonly timeout?: Duration.Input;
};

export type ExecResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

export class ExecError extends Schema.TaggedError<ExecError, { readonly brand: 'ExecError' }>()('ExecError', {
  command: Schema.String,
  message: Schema.String,
}) {}

const describeCommand = (command: string, args: ReadonlyArray<string>) => [command, ...args].join(' ');

export const commandFor = (command: string, args: ReadonlyArray<string>, options: ExecOptions) => {
  const stdin = Option.match(Option.fromUndefinedOr(options.stdin), {
    onNone: () => 'ignore' as const,
    onSome: (text) => ({ stream: Stream.make(new TextEncoder().encode(text)) }),
  });

  return ChildProcess.make(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    extendEnv: Option.isNone(Option.fromUndefinedOr(options.env)),
    stdin,
    forceKillAfter: '5 seconds',
  });
};

export class Exec extends Context.Service<
  Exec,
  {
    // Never fails on a non-zero exit; the caller reads exitCode.
    run(command: string, args: ReadonlyArray<string>, options?: ExecOptions): Effect.Effect<ExecResult, ExecError>;
  }
>()('chernabog/Exec') {
  public static readonly layer = Layer.effect(
    Exec,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const run = (command: string, args: ReadonlyArray<string>, options: ExecOptions = {}) => {
        const collect = Effect.gen(function* () {
          const handle = yield* spawner.spawn(commandFor(command, args, options));

          const [stdout, stderr, exitCode] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode], {
            concurrency: 'unbounded',
          });

          return { exitCode: Number(exitCode), stdout, stderr };
        }).pipe(Effect.scoped);

        const failed = (error: { readonly message: string }) => new ExecError({ command: describeCommand(command, args), message: error.message });

        return Option.match(Option.fromUndefinedOr(options.timeout), {
          onNone: () => Effect.mapError(collect, failed),
          onSome: (timeout) => Effect.mapError(Effect.timeout(collect, timeout), failed),
        });
      };

      return Exec.of({ run });
    }),
  );
}

// Runs a program and fails unless it exits 0, returning what it printed.
export const execOk = (command: string, args: ReadonlyArray<string>, options?: ExecOptions) =>
  Effect.gen(function* () {
    const exec = yield* Exec;
    const result = yield* exec.run(command, args, options);

    if (result.exitCode !== 0) {
      let said = result.stderr.trim();

      if (said.length === 0) said = result.stdout.trim();

      return yield* new ExecError({ command: describeCommand(command, args), message: `exited ${result.exitCode}: ${said}` });
    }

    return result.stdout;
  });

// A fake for tests: each call is answered by the first handler that returns a result.
export const execTestLayer = (handler: (command: string, args: ReadonlyArray<string>) => Option.Option<ExecResult>) =>
  Layer.succeed(
    Exec,
    Exec.of({
      run: (command, args) =>
        Effect.fromOption(handler(command, args)).pipe(
          Effect.mapError(() => new ExecError({ command: describeCommand(command, args), message: 'no fake answers this command' })),
        ),
    }),
  );
