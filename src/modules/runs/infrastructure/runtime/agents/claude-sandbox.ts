// What an interactive Claude session in a Docker or Podman container is given
// (ADR 24, "The container"): its mounts, the worktree and the repo's common
// git dir at their host paths, with the common dir's config and hooks
// read-only over it, and a Claude config dir of its own in the session dir;
// and an environment of its own, with nothing of the host's but what the
// session needs, since the host's PATH and HOME name nothing in the image.

import { AgentError, type AgentRequest, printJson } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { CLAUDE_OAUTH_TOKEN } from "../../../../../platform/agent-accounts.ts";
import { setTokenCommand, storedClaudeToken } from "../../../../../platform/claude-tokens.ts";
import { type Environment } from "../../../../../platform/environment.ts";
import { type ContainerMount, type ContainerSpec } from "../launchers/container.ts";
import { type AdapterContext } from "./adapter.ts";
import {
  checkMountable,
  gitIdentity,
  personaCredentials,
  repoMounts,
  sessionLabels,
} from "./container-session.ts";
import { type SessionFiles } from "./session-files.ts";

// What a fresh config dir needs so Claude starts at its prompt: onboarding
// done, and the worktree trusted, as the runner's seed does (ci-run).
export const sandboxClaudeSeed = (cwd: string) =>
  printJson({
    hasCompletedOnboarding: true,
    theme: "dark",
    projects: { [cwd]: { hasTrustDialogAccepted: true } },
  });

// The session's own config dir, the account's Claude token and the persona's
// GH_TOKEN, and nothing else: none of the host's variables, nor anything
// else the repo or persona adds (the PATH a repo pins names nothing in the image).
export const sandboxedClaudeEnvironment = (
  context: AdapterContext,
  configDir: string,
  claudeToken: string,
): Environment => ({
  ...personaCredentials(context.env),
  CLAUDE_CONFIG_DIR: configDir,
  [CLAUDE_OAUTH_TOKEN]: claudeToken,
});

// A sandboxed session can't read the macOS Keychain, so it signs in with the
// token stored for its account (ADR 24, decision 7), and is refused without
// one, as a sandbox that can't start is (decision 2).
const accountToken = (context: AdapterContext) =>
  Effect.flatMap(storedClaudeToken(context.account.name), Effect.fromOption).pipe(
    Effect.mapError(
      () =>
        new AgentError({
          message: `claude: sandbox ${context.sandbox.name}: account ${context.account.name} has no Claude token for a sandboxed session, which can't read the login on this machine: run \`claude setup-token\` as that account, then pipe or paste the token it prints into \`${setTokenCommand(context.account.name)}\``,
        }),
    ),
  );

export const sandboxedLaunch = (
  request: AgentRequest,
  context: AdapterContext,
  files: SessionFiles,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const image = yield* Effect.fromOption(context.image).pipe(
      Effect.mapError(
        () => new AgentError({ message: `claude: sandbox ${context.sandbox.name} has no image` }),
      ),
    );

    const claudeToken = yield* accountToken(context);
    const repo = yield* repoMounts("claude", request.cwd);
    yield* fs.makeDirectory(files.claude, { recursive: true });

    const seed = `${files.claude}/.claude.json`;

    if (!(yield* fs.exists(seed))) {
      yield* fs.writeFileString(seed, sandboxClaudeSeed(request.cwd));
    }

    const mounts: ReadonlyArray<ContainerMount> = [
      ...repo,
      { path: files.claude },
      { path: files.settings, readOnly: true },
    ];

    yield* checkMountable("claude", mounts);

    const container: ContainerSpec = {
      image,
      mounts,
      labels: yield* sessionLabels(request.sessionId),
    };

    const env = {
      ...sandboxedClaudeEnvironment(context, files.claude, claudeToken),
      ...(yield* gitIdentity(request.cwd)),
    };

    return { container, env };
  });
