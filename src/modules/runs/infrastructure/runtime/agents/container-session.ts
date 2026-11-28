// What every agent's sandboxed session is given, whichever agent it runs
// (ADR 24, "The container"): the repo's common git dir to mount beside the
// worktree, with its config and hooks read-only over it, who the person's
// commits are by, the persona's GitHub credential, and the run's and
// session's labels.

import { AgentError, Run } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import { type Environment } from "../../../../../platform/environment.ts";
import { Exec } from "../../../../../platform/exec.ts";
import { gitCredentialEnv } from "../../../../../platform/github-auth.ts";
import {
  type ContainerMount,
  RUN_LABEL,
  SESSION_LABEL,
  unmountable,
} from "../launchers/container.ts";

// The repo's common git dir, by absolute path, as git names it from the worktree.
const commonGitDir = (agent: string, cwd: string) =>
  Effect.gen(function* () {
    const exec = yield* Exec;

    const result = yield* exec
      .run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd })
      .pipe(Effect.mapError((error) => new AgentError({ message: `${agent}: ${error.message}` })));

    if (result.exitCode !== 0) {
      return yield* new AgentError({
        message: `${agent}: can't find ${cwd}'s git dir to mount into its sandbox: ${result.stderr.trim()}`,
      });
    }

    return result.stdout.trim();
  });

// The worktree and the repo's common git dir, read-write at their host
// paths, with the common dir's config and hooks read-only over it, where
// each exists: git runs what they name on the host too.
export const repoMounts = (agent: string, cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const common = yield* commonGitDir(agent, cwd);

    const readOnly = yield* Effect.filter([`${common}/config`, `${common}/hooks`], (path) =>
      fs.exists(path).pipe(Effect.orElseSucceed(() => false)),
    );

    return [
      { path: cwd },
      { path: common },
      ...readOnly.map((path) => ({ path, readOnly: true })),
    ] satisfies ReadonlyArray<ContainerMount>;
  });

// Refuses mounts `--volume` can't name.
export const checkMountable = (agent: string, mounts: ReadonlyArray<ContainerMount>) =>
  Effect.forEach(
    mounts.filter((each) => unmountable(each.path)),
    (mount) =>
      Effect.fail(
        new AgentError({
          message: `${agent}: ${mount.path} can't be mounted into a container at its own path: it has a ':' in it`,
        }),
      ),
  );

// Who the person's commits are by, from the host's git config in the
// worktree: the container has none of the person's own.
export const gitIdentity = (cwd: string) =>
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

// Of the persona's variables, its GH_TOKEN and the git config that answers
// github.com with it: the one credential a session gets besides its agent's
// (ADR 24, decision 7). Not GITHUB_TOKEN, the same token by another name.
const PERSONA_VARIABLES: ReadonlyArray<string> = ["GH_TOKEN", ...Object.keys(gitCredentialEnv)];

// Of what the repo and persona add, only the persona's credential: nothing
// else (the PATH a repo pins names nothing in the image).
export const personaCredentials = (env: Environment): Environment =>
  Record.filter(env, (_, name) => PERSONA_VARIABLES.includes(name));

// The run's and session's labels, by which cancel and the sweep remove a
// session's containers (decision 9).
export const sessionLabels = (sessionId: string) =>
  Effect.map(Effect.serviceOption(Run), (run) => ({
    ...Option.match(run, {
      onNone: () => ({}),
      onSome: ({ runId }) => ({ [RUN_LABEL]: runId }),
    }),
    [SESSION_LABEL]: sessionId,
  }));
