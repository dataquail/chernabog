// A Codex session in the repo's Docker or Podman container (ADR 24, decision
// 4). Codex runs headless, so its adapter runs the container itself, `run -i`
// with the prompt on stdin, rather than `__launch` under a launcher. Codex's
// own workspace sandbox is off in there (codex.ts): the container is the
// sandbox. Its CODEX_HOME is the session's own, in the session dir, where its
// threads' rollouts stay for a resume and for what a call spent. It signs in
// with the account's ChatGPT login from this machine, handed over by name in
// the environment (decision 7) and written into that CODEX_HOME by the
// container's entry; a login Codex refreshed in there goes back to the
// account, since the refresh token it used no longer works.

import { AgentError, type AgentRequest } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { codexHomeOf } from "../../../../../platform/agent-accounts.ts";
import { writeFileAtomic } from "../../../../../platform/atomic-write.ts";
import { type Environment } from "../../../../../platform/environment.ts";
import { Home } from "../../../../../platform/home.ts";
import {
  type ContainerMount,
  containerRunArgs,
  removeSessionContainers,
} from "../launchers/container.ts";
import { sandboxImage } from "../sandboxes.ts";
import { type AdapterContext } from "./adapter.ts";
import {
  checkMountable,
  gitIdentity,
  personaCredentials,
  repoMounts,
  sessionLabels,
} from "./container-session.ts";
import { type SessionFiles } from "./session-files.ts";

// The variable the account's login reaches the container's entry in.
export const CODEX_LOGIN_ENV = "CHERNABOG_CODEX_LOGIN";

// Writes the login into CODEX_HOME, readable only by the session's user,
// and runs codex without it in its environment, so the commands codex runs
// don't see it there.
const ENTRY = `umask 077 && printf '%s' "$${CODEX_LOGIN_ENV}" > "$CODEX_HOME/auth.json" && unset ${CODEX_LOGIN_ENV} && exec codex "$@"`;

export const codexInContainer = (args: ReadonlyArray<string>) => ({
  command: "sh",
  args: ["-c", ENTRY, "codex", ...args],
});

// The session's own CODEX_HOME, the account's login and the persona's
// GH_TOKEN, and nothing else of the host's, the repo's or the persona's.
export const sandboxedCodexEnvironment = (
  env: Environment,
  codexHome: string,
  login: string,
): Environment => ({
  ...personaCredentials(env),
  CODEX_HOME: codexHome,
  [CODEX_LOGIN_ENV]: login,
});

// A ChatGPT login as Codex keeps it in auth.json: tokens for an account, and
// when it last refreshed them. An API key's login has no tokens, and
// chernabog only spends subscription capacity.
const Login = Schema.fromJsonString(
  Schema.Struct({
    tokens: Schema.Struct({ account_id: Schema.optionalKey(Schema.String) }),
    last_refresh: Schema.String,
  }),
);

const loginOf = Schema.decodeOption(Login);

// The login a session left to keep on the host: one Codex refreshed, for the
// same account, newer than the one it was given. None for anything else, so
// a session can't swap the account's login for another.
export const refreshedLogin = (given: string, left: string): Option.Option<string> => {
  if (left === given) {
    return Option.none();
  }

  return Option.flatMap(Option.all([loginOf(given), loginOf(left)]), ([was, now]) =>
    Option.liftPredicate(
      left,
      () =>
        was.tokens.account_id === now.tokens.account_id &&
        Date.parse(now.last_refresh) > Date.parse(was.last_refresh),
    ),
  );
};

const codexLoginCommand = (home: string) => `CODEX_HOME=${home} codex login`;

// The account's ChatGPT login on this machine, which a session in a
// container can't read; refused without one, as a sandbox that can't start
// is (decision 2).
const accountLogin = (context: AdapterContext, file: string, home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file).pipe(Effect.option);

    return yield* Effect.fromOption(
      Option.filter(text, (found) => Option.isSome(loginOf(found))),
    ).pipe(
      Effect.mapError(
        () =>
          new AgentError({
            message: `codex: sandbox ${context.sandbox.name}: account ${context.account.name} has no Codex login at ${file} for a sandboxed session to sign in with: run \`${codexLoginCommand(home)}\` and sign in with ChatGPT, with Codex keeping its login in that file`,
          }),
      ),
    );
  });

// Keeps a login the session refreshed on the host, and leaves none in the
// session's CODEX_HOME.
const settleLogin = (given: string, hostFile: string, files: SessionFiles) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const left = `${files.codex}/auth.json`;
    const text = yield* fs.readFileString(left).pipe(Effect.option);

    for (const refreshed of Option.toArray(
      Option.flatMap(text, (found) => refreshedLogin(given, found)),
    )) {
      yield* writeFileAtomic(fs, hostFile, refreshed, 0o600);
    }

    yield* fs.remove(left, { force: true });
  }).pipe(Effect.ignore);

type Runtime = "docker" | "podman";

// The runtime's CLI running codex in the session's container, with the
// session's own mounts and environment, and what to do once it has ended.
export const sandboxedCodex = (
  runtime: Runtime,
  request: AgentRequest,
  context: AdapterContext,
  files: SessionFiles,
  scratch: string,
  codexArguments: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;

    const image = yield* Effect.fromOption(sandboxImage(context.host)).pipe(
      Effect.mapError(
        () => new AgentError({ message: `codex: sandbox ${context.sandbox.name} has no image` }),
      ),
    );

    const accountHome = codexHomeOf(context.account, home.user);
    const hostFile = `${accountHome}/auth.json`;
    const login = yield* accountLogin(context, hostFile, accountHome);
    yield* fs.makeDirectory(files.codex, { recursive: true });

    const mounts: ReadonlyArray<ContainerMount> = [
      ...(yield* repoMounts("codex", request.cwd)),
      { path: files.codex },
      { path: scratch },
    ];

    yield* checkMountable("codex", mounts);

    const env = {
      ...sandboxedCodexEnvironment(context.env, files.codex, login),
      ...(yield* gitIdentity(request.cwd)),
    };

    const entry = codexInContainer(codexArguments);

    const args = containerRunArgs(
      runtime,
      { command: entry.command, args: entry.args, cwd: request.cwd, env },
      { image, mounts, labels: yield* sessionLabels(request.sessionId) },
      {
        platform: process.platform,
        uid: Option.fromUndefinedOr(process.getuid?.()),
        gid: Option.fromUndefinedOr(process.getgid?.()),
        tty: false,
      },
    );

    // The runtime's CLI runs with this process's environment, for its own
    // socket and config, and the session's, which it hands the container by name.
    const cliEnv = { ...context.host, ...env };

    return {
      command: runtime,
      args,
      env: cliEnv,
      // A container outlives its CLI, so one a stopped call left is removed
      // by its label; --rm removes one that ended.
      settle: Effect.andThen(
        removeSessionContainers(runtime, request.sessionId, cliEnv),
        settleLogin(login, hostFile, files),
      ),
    };
  });
