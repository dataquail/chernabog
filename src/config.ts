import type { Account } from "@chernabog/sdk";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { Environment } from "./platform/environment.ts";

export { expandHome, Home, homePaths } from "./platform/home.ts";

export class ConfigError extends Schema.TaggedError<
  ConfigError,
  { readonly brand: "ConfigError" }
>()("ConfigError", {
  message: Schema.String,
}) {}

// Where an account keeps its settings, skills and session transcripts.
export const claudeHomeOf = (account: Account, home: string) =>
  Option.getOrElse(account.configDir, () => `${home}/.claude`);

// Claude Code's variable for a login token. It beats any config directory's login.
export const CLAUDE_OAUTH_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";

// An account's token, from the host variable its oauthTokenEnv names.
export const claudeTokenOf = (account: Account, host: Environment) =>
  Option.flatMap(account.oauthTokenEnv, (name) => Option.fromUndefinedOr(host[name]));

// What logs `claude` in with the account's token; nothing for an account without one.
export const claudeTokenVariables = (account: Account, host: Environment): Environment =>
  Option.match(claudeTokenOf(account, host), {
    onNone: () => ({}),
    onSome: (token) => ({ [CLAUDE_OAUTH_TOKEN]: token }),
  });

// Where a Codex account keeps its login and session logs.
export const codexHomeOf = (account: Account, home: string) =>
  Option.getOrElse(account.configDir, () => `${home}/.codex`);
