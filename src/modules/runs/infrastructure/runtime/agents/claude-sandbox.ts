// What an interactive Claude session in a Docker or Podman container is given
// (ADR 24, "The container"): its mounts, the worktree and the repo's common
// git dir at their host paths, with the common dir's config and hooks
// read-only over it, and a Claude config dir of its own in the session dir;
// and an environment of its own, with nothing of the host's but what the
// session needs, since the host's PATH and HOME name nothing in the image.

import { AgentError, type AgentRequest, printJson, Run } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { claudeTokenVariables } from "../../../../../platform/agent-accounts.ts";
import { type Environment, withVariables } from "../../../../../platform/environment.ts";
import { Exec } from "../../../../../platform/exec.ts";
import {
  type ContainerMount,
  type ContainerSpec,
  RUN_LABEL,
  SESSION_LABEL,
  unmountable,
} from "../launchers/container.ts";
import { sandboxImage } from "../sandboxes.ts";
import { type AdapterContext, API_KEYS } from "./adapter.ts";
import { type SessionFiles } from "./session-files.ts";

// The repo's common git dir, by absolute path, as git names it from the worktree.
const commonGitDir = (cwd: string) =>
  Effect.gen(function* () {
    const exec = yield* Exec;

    const result = yield* exec
      .run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd })
      .pipe(Effect.mapError((error) => new AgentError({ message: `claude: ${error.message}` })));

    if (result.exitCode !== 0) {
      return yield* new AgentError({
        message: `claude: can't find ${cwd}'s git dir to mount into its sandbox: ${result.stderr.trim()}`,
      });
    }

    return result.stdout.trim();
  });

// Who the person's commits are by, from the host's git config in the
// worktree: the container has none of the person's own.
const gitIdentity = (cwd: string) =>
  Effect.gen(function* () {
    const exec = yield* Exec;

    const read = (key: string) =>
      exec.run("git", ["config", key], { cwd }).pipe(
        Effect.map((result) =>
          Option.filter(
            Option.some(result.stdout.trim()),
            (value) => result.exitCode === 0 && value.length > 0,
          ),
        ),
        Effect.orElseSucceed(() => Option.none<string>()),
      );

    const name = yield* read("user.name");
    const email = yield* read("user.email");

    return {
      ...Option.match(name, {
        onNone: () => ({}),
        onSome: (value) => ({ GIT_AUTHOR_NAME: value, GIT_COMMITTER_NAME: value }),
      }),
      ...Option.match(email, {
        onNone: () => ({}),
        onSome: (value) => ({ GIT_AUTHOR_EMAIL: value, GIT_COMMITTER_EMAIL: value }),
      }),
    } satisfies Environment;
  });

// What a fresh config dir needs so Claude starts at its prompt: onboarding
// done, and the worktree trusted, as the runner's seed does (ci-run).
export const sandboxClaudeSeed = (cwd: string) =>
  printJson({
    hasCompletedOnboarding: true,
    theme: "dark",
    projects: { [cwd]: { hasTrustDialogAccepted: true } },
  });

// The session's own variables, the persona's (context.env, less the PATH a
// repo pins for the host) and the account's token, and nothing of the host's.
export const sandboxedClaudeEnvironment = (
  context: AdapterContext,
  configDir: string,
): Environment => ({
  ...withVariables(context.env, { CLAUDE_CONFIG_DIR: configDir }, [...API_KEYS, "PATH", "HOME"]),
  ...claudeTokenVariables(context.account, context.host),
});

export const sandboxedLaunch = (
  request: AgentRequest,
  context: AdapterContext,
  files: SessionFiles,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const image = yield* Effect.fromOption(sandboxImage(context.host)).pipe(
      Effect.mapError(
        () => new AgentError({ message: `claude: sandbox ${context.sandbox.name} has no image` }),
      ),
    );

    const common = yield* commonGitDir(request.cwd);
    yield* fs.makeDirectory(files.claude, { recursive: true });

    const seed = `${files.claude}/.claude.json`;

    if (!(yield* fs.exists(seed))) {
      yield* fs.writeFileString(seed, sandboxClaudeSeed(request.cwd));
    }

    const readOnly = yield* Effect.filter([`${common}/config`, `${common}/hooks`], (path) =>
      fs.exists(path).pipe(Effect.orElseSucceed(() => false)),
    );

    const mounts: ReadonlyArray<ContainerMount> = [
      { path: request.cwd },
      { path: common },
      ...readOnly.map((path) => ({ path, readOnly: true })),
      { path: files.claude },
      { path: files.settings, readOnly: true },
    ];

    for (const mount of mounts.filter((each) => unmountable(each.path))) {
      return yield* new AgentError({
        message: `claude: ${mount.path} can't be mounted into a container at its own path: it has a ':' in it`,
      });
    }

    const run = yield* Effect.serviceOption(Run);

    const container: ContainerSpec = {
      image,
      mounts,
      labels: {
        ...Option.match(run, {
          onNone: () => ({}),
          onSome: ({ runId }) => ({ [RUN_LABEL]: runId }),
        }),
        [SESSION_LABEL]: request.sessionId,
      },
    };

    const env = {
      ...sandboxedClaudeEnvironment(context, files.claude),
      ...(yield* gitIdentity(request.cwd)),
    };

    return { container, env };
  });
