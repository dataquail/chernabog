// Where the agents keep an account's login on this machine, and how a login
// token reaches `claude`.

import type { Account } from "@chernabog/sdk";
import * as Option from "effect/Option";

import type { Environment } from "./environment.ts";

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
