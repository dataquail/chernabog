// The commands a sandboxed repo's flows run, such as its install and local
// gate (ADR 24, decision 10): each runs in a container from the repo's
// image, with the worktree and the repo's common git dir mounted at their
// host paths as for a session, the person's user mapping, and no agent's or
// persona's credentials and no session mounts. The flow asks for a process as
// it always has; the spawner a sandboxed repo's flows are given runs it with
// the runtime's CLI instead, so nothing a flow runs there reaches the
// person's home outside those mounts, and nothing falls back to the host.

import { type RepoSettings, type ResolvedSandbox, Run, RunLog } from "@chernabog/core";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Scope from "effect/Scope";

import { type Environment } from "../../../../platform/environment.ts";
import { type Exec } from "../../../../platform/exec.ts";
import { gitCredentialEnv } from "../../../../platform/github-auth.ts";
import { checkMountable, repoMounts } from "./agents/container-session.ts";
import {
  COMMAND_LABEL,
  type ContainerHost,
  containerRunArgs,
  type ContainerSpec,
  removeLabelledContainers,
  RUN_LABEL,
} from "./launchers/container.ts";
import { type BuildUser, sandboxImage } from "./sandbox-image.ts";

type Runtime = "docker" | "podman";

// What a command's own environment may not carry into the container: the
// host's PATH and HOME name nothing in the image, and no credential goes in
// (decision 10), whichever variable a flow put it in.
const KEPT_OUT: ReadonlyArray<string> = [
  "PATH",
  "HOME",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CHERNABOG_CODEX_LOGIN",
  ...Object.keys(gitCredentialEnv),
];

// The variables a command asked for itself, less what may not go in. None of
// the host's own: the runtime's CLI hands the container only these, by name.
export const containerEnvironment = (env: ChildProcess.CommandOptions["env"]): Environment =>
  Object.fromEntries(
    Object.entries(Option.getOrElse(Option.fromUndefinedOr(env), () => ({}))).flatMap(
      ([name, value]) =>
        Option.toArray(
          Option.map(
            Option.filter(Option.fromUndefinedOr(value), () => !KEPT_OUT.includes(name)),
            (kept) => [name, kept] as const,
          ),
        ),
    ),
  );

const refused = (description: string) =>
  PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description });

// The runtime's CLI running `command` in the container `container` holds,
// with the command's variables handed over by name. The CLI itself runs with
// this process's environment, for its own socket and config.
export const inContainer = (
  runtime: Runtime,
  command: ChildProcess.StandardCommand,
  cwd: string,
  container: ContainerSpec,
  host: ContainerHost,
): ChildProcess.StandardCommand => {
  const env = containerEnvironment(command.options.env);

  const args = containerRunArgs(
    runtime,
    { command: command.command, args: command.args, cwd, env },
    container,
    host,
  );

  return ChildProcess.make(runtime, args, {
    ...command.options,
    cwd,
    env,
    extendEnv: true,
  });
};

export type SandboxedCommands = {
  readonly sandbox: ResolvedSandbox & { readonly name: Runtime };
  readonly settings: Pick<RepoSettings, "configDir" | "slug">;
  readonly user: BuildUser;
  readonly platform: string;
};

const thisHost = (commands: SandboxedCommands): ContainerHost => ({
  platform: commands.platform,
  uid: commands.user.uid,
  gid: commands.user.gid,
  tty: false,
});

// A flow's spawner for a sandboxed repo: each process it starts is a
// container from the repo's image (built first when the runtime hasn't got
// it), in the command's working directory, which must be a worktree. A
// container outlives its CLI, so the one a stopped command left is removed by
// its own label when the command's scope closes; it carries the run's too,
// for cancel and the sweep (decision 9).
export const sandboxedSpawner = (
  commands: SandboxedCommands,
  services: Context.Context<
    FileSystem.FileSystem | Exec | Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner
  >,
) => {
  const host = Context.get(services, ChildProcessSpawner.ChildProcessSpawner);
  const runtime = commands.sandbox.name;

  const containerFor = (command: ChildProcess.StandardCommand) =>
    Effect.gen(function* () {
      if (
        Option.isSome(
          Option.filter(Option.fromUndefinedOr(command.options.shell), (shell) => shell !== false),
        )
      ) {
        return yield* refused(
          `sandbox ${runtime}: ${command.command} asks for a host shell, which a sandboxed repo's commands don't run in`,
        );
      }

      const cwd = yield* Effect.fromOption(Option.fromUndefinedOr(command.options.cwd)).pipe(
        Effect.mapError(() =>
          refused(
            `sandbox ${runtime}: ${command.command} names no worktree to run in, and a sandboxed repo's commands run only in one`,
          ),
        ),
      );

      const log = yield* Effect.serviceOption(RunLog);

      const image = yield* sandboxImage({
        sandbox: commands.sandbox,
        configDir: commands.settings.configDir,
        slug: commands.settings.slug,
        user: commands.user,
        log: (line) =>
          Option.match(log, { onNone: () => Effect.void, onSome: (runLog) => runLog.log(line) }),
      });

      const mounts = yield* repoMounts(`sandbox ${runtime}`, cwd);
      yield* checkMountable(`sandbox ${runtime}`, mounts);
      const run = yield* Effect.serviceOption(Run);
      const id = yield* Crypto.Crypto.use((random) => random.randomUUIDv4());

      const labels = {
        ...Option.match(run, {
          onNone: () => ({}),
          onSome: ({ runId }) => ({ [RUN_LABEL]: runId }),
        }),
        [COMMAND_LABEL]: id,
      };

      return {
        id,
        inside: inContainer(runtime, command, cwd, { image, mounts, labels }, thisHost(commands)),
      };
    }).pipe(
      Effect.catchTags({
        AgentError: (error) => Effect.fail(refused(error.message)),
      }),
      Effect.provideContext(services),
      Effect.tap(({ id }) =>
        Effect.addFinalizer(() =>
          removeLabelledContainers(runtime, { name: COMMAND_LABEL, value: id }, {}).pipe(
            Effect.provideContext(services),
          ),
        ),
      ),
      Effect.map(({ inside }) => inside),
    );

  const contained = (
    command: ChildProcess.Command,
  ): Effect.Effect<ChildProcess.Command, PlatformError.PlatformError, Scope.Scope> => {
    if (ChildProcess.isStandardCommand(command)) {
      return containerFor(command);
    }

    return Effect.zipWith(contained(command.left), contained(command.right), (left, right) =>
      ChildProcess.pipeTo(left, right, command.options),
    );
  };

  return ChildProcessSpawner.make((command) =>
    Effect.flatMap(contained(command), (inside) => host.spawn(inside)),
  );
};
