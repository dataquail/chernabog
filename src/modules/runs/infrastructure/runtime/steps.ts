// Steps from a repo's .chernabog/stages/ run in a child process: an Effect
// step in a child of this same binary, a shell step as its own executable. A
// step that crashes or hangs fails only its activity, never the scheduler or
// the workflow engine. Both kinds follow one contract: context on stdin, exit 0
// to continue, 78 to skip, anything else to fail.

import {
  describeError,
  FlowPackage,
  type Json,
  parseJson,
  printJson,
  type RepoSettings,
  RepoSettings as RepoSettingsSchema,
  Run,
  RunInfo,
  RunLog,
  Skip,
  STEP_EXIT,
  StepFailed,
  StepRunner,
} from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import { IMPLICIT, type Persona } from "../../../../kernel/persona.value-object.ts";
import type { Environment } from "../../../../platform/environment.ts";
import { findStage, loadStage } from "../../../../platform/flow-loader.ts";
import { GitHubApi } from "../../../../platform/github-api.ts";
import { GitHubTokens } from "../../../../platform/github-auth.ts";
import { selfCommand } from "../../../../platform/self.ts";
import { AgentFile, UsageGateFile } from "../../../../repo-config.ts";
import { adaptersFor, AgentLive, type AgentsConfig } from "./agents.ts";
import { GitHubLive, GitLive, RepoLive, UsageLive, WorktreeLive } from "./sdk-live.ts";
import type { GateConfig } from "./usage-gate.ts";

// What the parent hands an Effect step's process on stdin.
export const StepContext = Schema.Struct({
  stage: Schema.String,
  input: Schema.Json,
  repo: RepoSettingsSchema,
  run: Schema.Option(RunInfo),
  gate: UsageGateFile,
  agents: Schema.Record(Schema.String, AgentFile),
  outputPath: Schema.String,
});

export type StepContext = typeof StepContext.Type;

const StepContextJson = Schema.fromJsonString(Schema.toCodecJson(StepContext));

const DEFAULT_STEP_TIMEOUT = Duration.hours(1);

const lastLines = (text: string, count = 20) => text.trimEnd().split("\n").slice(-count).join("\n");

type ChildResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

// `env` is set over this process's environment, which the child inherits.
type Child = {
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly stdin: string;
  readonly timeout: Duration.Duration;
  readonly env: Environment;
};

// Runs the step's process, copying each line it writes to stderr into the run's log.
const runChild = (name: string, child: Child, log: (line: string) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const [command = "sh", ...args] = child.command;

    const handle = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        cwd: child.cwd,
        env: child.env,
        extendEnv: true,
        stdin: { stream: Stream.make(new TextEncoder().encode(child.stdin)) },
        forceKillAfter: "5 seconds",
      }),
    );

    let stderr = "";

    const errors = handle.stderr.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0),
      Stream.runForEach((line) =>
        Effect.suspend(() => {
          stderr = `${stderr}${line}\n`.slice(-20_000);

          return log(line);
        }),
      ),
    );

    const [stdout, , exitCode] = yield* Effect.all(
      [Stream.mkString(Stream.decodeText(handle.stdout)), errors, handle.exitCode],
      { concurrency: "unbounded" },
    );

    return { exitCode: Number(exitCode), stdout, stderr } satisfies ChildResult;
  }).pipe(
    Effect.scoped,
    Effect.timeout(child.timeout),
    Effect.mapError((error) => new StepFailed({ step: name, message: describeError(error) })),
  );

const orElse = (text: string, fallback: string) => {
  if (text.length > 0) {
    return text;
  }

  return fallback;
};

// Turns a step's exit into its output, a Skip, or a failure.
export const interpretStepExit = (
  name: string,
  result: ChildResult,
  output: Option.Option<Json>,
) => {
  if (result.exitCode === STEP_EXIT.ok) {
    return Effect.fromOption(output).pipe(
      Effect.mapError(() => new StepFailed({ step: name, message: "its output is not JSON" })),
    );
  }

  if (result.exitCode === STEP_EXIT.skip) {
    return Effect.fail(
      new Skip({ reason: orElse(lastLines(result.stderr, 1), `step ${name} skipped`) }),
    );
  }

  const said = lastLines(orElse(result.stderr, result.stdout));

  return Effect.fail(new StepFailed({ step: name, message: `exited ${result.exitCode}: ${said}` }));
};

const logFor = (name: string) =>
  Effect.serviceOption(RunLog).pipe(
    Effect.map(
      Option.match({
        onNone: () => (line: string) => Console.error(`${name}: ${line}`),
        onSome: (runLog) => (line: string) => runLog.log(`${name}: ${line}`),
      }),
    ),
  );

const lastLine = (text: string) => Option.getOrElse(Arr.last(text.trim().split("\n")), () => "");

// Steps run as one persona: a step's process gets its token, so gh and git in
// it, and the services of an Effect step, act as that persona.
export const StepRunnerLive = (
  settings: RepoSettings,
  gate: GateConfig,
  agents: AgentsConfig,
  persona: Persona,
  timeout: Duration.Duration = DEFAULT_STEP_TIMEOUT,
) =>
  Layer.effect(
    StepRunner,
    Effect.gen(function* () {
      const services = yield* Effect.context<
        FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
      >();

      const tokens = yield* GitHubTokens;

      const run = (name: string, input: Json) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;

          // An imported flow's steps are its package's, unless the repo has its own.
          const flowPackage = Option.map(
            yield* Effect.serviceOption(FlowPackage),
            (found) => found.dir,
          );

          const found = yield* findStage(settings.configDir, name, flowPackage);

          if (Option.isNone(found)) {
            return yield* new StepFailed({
              step: name,
              message: `no step named ${name} in ${[settings.configDir, ...Option.toArray(flowPackage)].map((dir) => `${dir}/stages`).join(" or ")}`,
            });
          }

          const stage = found.value;
          const runInfo = yield* Effect.serviceOption(Run);
          const log = yield* logFor(name);

          const env = yield* tokens
            .env(persona)
            .pipe(
              Effect.mapError((error) => new StepFailed({ step: name, message: error.message })),
            );

          if (stage.kind === "shell") {
            // A shell step gets its input and where it runs; the run is named when there is one.
            let context: Json = { input, repo: settings.slug };

            if (Option.isSome(runInfo)) {
              context = { input, repo: settings.slug, run: runInfo.value.runId };
            }

            const stdin = printJson(context);

            const result = yield* runChild(
              name,
              { command: [stage.path], cwd: settings.path, stdin, timeout, env },
              log,
            );

            return yield* interpretStepExit(name, result, parseJson(lastLine(result.stdout)));
          }

          const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-step-" });

          const context: StepContext = {
            stage: stage.path,
            input,
            repo: settings,
            run: runInfo,
            gate,
            agents,
            outputPath: `${scratch}/output.json`,
          };

          const stdin = yield* Schema.encodeEffect(StepContextJson)(context);

          const result = yield* runChild(
            name,
            { command: [...selfCommand(), "__step"], cwd: settings.path, stdin, timeout, env },
            log,
          );

          let output = Option.none<Json>();

          if (result.exitCode === STEP_EXIT.ok) {
            output = parseJson(yield* fs.readFileString(context.outputPath));
          }

          return yield* interpretStepExit(name, result, output);
        }).pipe(
          Effect.scoped,
          Effect.catchTags({
            PlatformError: (error) =>
              Effect.fail(new StepFailed({ step: name, message: error.message })),
            SchemaError: (error) =>
              Effect.fail(new StepFailed({ step: name, message: error.message })),
          }),
          Effect.provide(services),
        );

      return StepRunner.of({ run });
    }),
  );

// What a step logs goes to stderr, which the parent copies into the run's log.
const stderrLog = RunLog.of({
  log: (line) => Console.error(line),
  step: (name) => Console.error(`step: ${name}`),
  stepDone: () => Effect.void,
});

// The SDK services a step can use, for one repo. The step's process already
// has its persona's token in its environment, so they act as the implicit
// persona, which is that one.
export const stepServices = (context: StepContext) =>
  Layer.mergeAll(
    RepoLive(context.repo),
    GitHubLive(context.repo).pipe(Layer.provide(GitHubApi.layer)),
    GitLive(IMPLICIT),
    WorktreeLive(context.repo, IMPLICIT),
    UsageLive(context.repo, context.gate),
    AgentLive(context.repo, adaptersFor(context.agents), IMPLICIT),
    Layer.succeed(RunLog, stderrLog),
    Option.match(context.run, {
      onNone: () => Layer.empty,
      onSome: (info) => Layer.succeed(Run, info),
    }),
  );

// The step this process runs: `chernabog __step` reads it from stdin.
export class CurrentStep extends Context.Service<CurrentStep, StepContext>()(
  "chernabog/CurrentStep",
) {
  public static readonly layer = Layer.effect(
    CurrentStep,
    Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio;
      const text = yield* Stream.mkString(Stream.decodeText(stdio.stdin));

      return yield* Schema.decodeEffect(StepContextJson)(text);
    }).pipe(Effect.orDie),
  );
}

// The step's services, for the repo its context names.
export const StepServicesLive = Layer.unwrap(
  CurrentStep.use((context) => Effect.succeed(stepServices(context))),
).pipe(Layer.provideMerge(CurrentStep.layer));

const toStepFailure =
  (name: string) =>
  <E>(error: E) => {
    if (Schema.is(Skip)(error)) {
      return error;
    }

    return new StepFailed({ step: name, message: describeError(error) });
  };

// The child side: run the step, write its output where the parent reads it.
export const runStepChild = Effect.gen(function* () {
  const context = yield* CurrentStep;
  const fs = yield* FileSystem.FileSystem;
  const stage = yield* loadStage(context.stage);

  const input = yield* Schema.decodeEffect(stage.input)(context.input).pipe(
    Effect.mapError(
      (issue) => new StepFailed({ step: stage.name, message: `input: ${issue.message}` }),
    ),
  );

  const output = yield* stage.run(input).pipe(Effect.mapError(toStepFailure(stage.name)));

  const encoded = yield* Schema.encodeEffect(stage.output)(output).pipe(
    Effect.mapError(
      (issue) => new StepFailed({ step: stage.name, message: `output: ${issue.message}` }),
    ),
  );

  yield* fs.writeFileString(context.outputPath, printJson(encoded));
}).pipe(
  Effect.catch((error) =>
    Effect.gen(function* () {
      if (Schema.is(Skip)(error)) {
        yield* Console.error(error.reason);
        process.exitCode = STEP_EXIT.skip;

        return;
      }

      yield* Console.error(describeError(error));
      process.exitCode = 1;
    }),
  ),
);
