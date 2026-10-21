// Each GitHub persona's token, and the environment that makes a child process
// act as that persona: gh and the API through GH_TOKEN, git through a
// credential helper that reads it. The token only ever lives in memory and in
// a child's environment, never on a command line or in a file.

import { GitHubError } from '@chernabog/sdk';
import * as Cache from 'effect/Cache';
import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';

import { Exec, execOk } from './Exec.ts';
import type { Persona } from './persona.ts';
import { type Environment, HostEnvironment, withVariables } from './platform/environment.ts';

// Variables gh reads a token from before any login it keeps. A persona's token
// lookup must not see them, or gh answers with them whatever --user asks for.
const TOKEN_VARIABLES = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

// Git configuration, through the environment, that answers github.com's
// credential requests with $GH_TOKEN. Set at command scope, it outranks the
// user's own config: the empty helpers clear whatever helpers came before
// (gh's own, set up by `gh auth setup-git`, answers as gh's active account).
export const gitCredentialEnv: Environment = {
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_1: '',
  GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_2: '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f',
};

export class GitHubTokens extends Context.Service<
  GitHubTokens,
  {
    // The persona's token. Looked up again after a while, so a refreshed login is picked up.
    token(persona: Persona): Effect.Effect<string, GitHubError>;
    // What a child process needs in its environment to act as the persona:
    // nothing for the implicit one, which acts as the daemon does.
    env(persona: Persona): Effect.Effect<Environment, GitHubError>;
  }
>()('chernabog/GitHubTokens') {
  public static readonly layer: Layer.Layer<GitHubTokens, never, Exec | HostEnvironment> = Layer.effect(
    GitHubTokens,
    Effect.gen(function* () {
      const exec = yield* Exec;
      const host = yield* HostEnvironment;
      const fromConfig = yield* Config.String('GH_TOKEN').pipe(Config.orElse(() => Config.String('GITHUB_TOKEN')), Config.option, Effect.orDie);

      const gh = (args: ReadonlyArray<string>, env: Option.Option<Environment>) =>
        execOk('gh', ['auth', 'token', ...args], Option.match(env, { onNone: () => ({}), onSome: (variables) => ({ env: variables }) })).pipe(
          Effect.provideService(Exec, exec),
          Effect.map((token) => token.trim()),
          Effect.mapError((error) => new GitHubError({ message: `${['gh auth token', ...args].join(' ')}: ${error.message}` })),
        );

      const lookup = (persona: Persona) =>
        Option.match(persona, {
          onNone: () => Option.match(fromConfig, { onNone: () => gh([], Option.none()), onSome: Effect.succeed }),
          onSome: (login) => gh(['--hostname', 'github.com', '--user', login], Option.some(withVariables(host.variables, {}, TOKEN_VARIABLES))),
        });

      // Keyed by persona; Options compare by value. A failure is retried soon,
      // rather than kept until the daemon restarts.
      const tokens = yield* Cache.makeWith(lookup, {
        capacity: 64,
        timeToLive: (exit) => {
          if (Exit.isSuccess(exit)) return '30 minutes';

          return '10 seconds';
        },
      });

      const token = (persona: Persona) => Cache.get(tokens, persona);

      const env = (persona: Persona) =>
        Option.match(persona, {
          onNone: () => Effect.succeed<Environment>({}),
          onSome: () => Effect.map(token(persona), (found): Environment => ({ GH_TOKEN: found, GITHUB_TOKEN: found, ...gitCredentialEnv })),
        });

      return GitHubTokens.of({ token, env });
    }),
  );

  // A fake for tests: a fixed token per persona, "token-<login>", and the implicit one's.
  public static readonly fixed = (implicit: string) =>
    Layer.succeed(
      GitHubTokens,
      GitHubTokens.of({
        token: (persona) => Effect.succeed(Option.match(persona, { onNone: () => implicit, onSome: (login) => `token-${login}` })),
        env: (persona) =>
          Effect.succeed(Option.match(persona, { onNone: (): Environment => ({}), onSome: (login): Environment => ({ GH_TOKEN: `token-${login}`, GITHUB_TOKEN: `token-${login}`, ...gitCredentialEnv }) })),
      }),
    );
}
