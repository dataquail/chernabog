// `chernabog accounts`: what a machine's AI accounts need that `setup` doesn't
// ask for. `set-token` keeps a Claude account's `claude setup-token` token in
// the chernabog home, readable only by the person, for the sessions that
// can't read the macOS Keychain: sandboxed ones (ADR 24, decision 7). The
// token is read from stdin, or asked for hidden in a terminal, never taken
// from the command line, where `ps` and shell history would show it.

import * as Arr from "effect/Array";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Prompt from "effect/cli/Prompt";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import { storeClaudeToken } from "../../platform/claude-tokens.ts";
import { ConfigError } from "../../platform/config-error.ts";

const refuse = (message: string) => new ConfigError({ message });

// An account's name is its token file's name, so it stays one path segment.
const FILE_NAME = /^[\w.-]+$/;

const readToken = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;

  if (yield* stdio.stdinIsTerminal) {
    const asked = yield* Prompt.run(
      Prompt.Password({ message: "The token `claude setup-token` printed" }),
    ).pipe(Effect.mapError(() => refuse("cancelled: no token stored")));

    return Redacted.value(asked).trim();
  }

  const text = yield* Stream.mkString(Stream.decodeText(stdio.stdin)).pipe(
    Effect.mapError((error) => refuse(`could not read the token from stdin: ${error.message}`)),
  );

  return text.trim();
});

// The machine's accounts, by name and the agent each runs, from machine
// config, which the CLI's root reads.
export type AccountsAccess<R> = {
  readonly accounts: Effect.Effect<
    ReadonlyArray<{ readonly name: string; readonly agent: string }>,
    ConfigError,
    R
  >;
};

export const setClaudeToken = <R>(access: AccountsAccess<R>, name: string) =>
  Effect.gen(function* () {
    const accounts = yield* access.accounts;

    const account = yield* Effect.fromOption(
      Arr.findFirst(accounts, (candidate) => candidate.name === name),
    ).pipe(
      Effect.mapError(() =>
        refuse(`account "${name}" is not one of ${accounts.map((known) => known.name).join(", ")}`),
      ),
    );

    if (account.agent !== "claude") {
      return yield* refuse(
        `${name} is a ${account.agent} account; only a Claude account takes a token from \`claude setup-token\``,
      );
    }

    if (!FILE_NAME.test(name)) {
      return yield* refuse(
        `account "${name}" can't name a file: rename it to letters, digits, '.', '_' and '-'`,
      );
    }

    const token = yield* readToken;

    if (token.length === 0) {
      return yield* refuse(
        `no token: run \`claude setup-token\` as ${name}, then pipe the token it prints into this command, or paste it when asked`,
      );
    }

    const path = yield* storeClaudeToken(name, token).pipe(
      Effect.mapError((error) => refuse(`could not store ${name}'s token: ${error.message}`)),
    );

    yield* Console.log(
      `stored account ${name}'s Claude token at ${path}, readable only by you; its sandboxed sessions sign in with it`,
    );
  });

const setToken = <R>(access: AccountsAccess<R>) =>
  Command.make("set-token", { account: Argument.String("account") }, ({ account }) =>
    setClaudeToken(access, account),
  ).pipe(
    Command.withDescription(
      "Keep a Claude account's token from `claude setup-token` for its sandboxed sessions, read from stdin or asked for hidden",
    ),
  );

export const accountsCommand = <R>(access: AccountsAccess<R>) =>
  Command.make("accounts", {}, () => Console.log("chernabog accounts set-token <account>")).pipe(
    Command.withDescription(
      "What this machine's AI accounts need beyond setup: a Claude account's token for sandboxed sessions",
    ),
    Command.withSubcommands([setToken(access)]),
  );
