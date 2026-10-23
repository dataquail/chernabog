import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

// The person's home, where the agents keep their logins: ~/.claude,
// ~/.claude-personal, ~/.codex and the like.
export type AccountDirsClientService = {
  // The person's home directory, which ~ means.
  readonly home: Effect.Effect<string>;
  // The agents' account directories directly in the home, in full, sorted.
  readonly found: Effect.Effect<ReadonlyArray<string>>;
  readonly exists: (dir: string) => Effect.Effect<boolean>;
};

export class AccountDirsClient extends Context.Service<
  AccountDirsClient,
  AccountDirsClientService
>()("AccountDirsClient") {}
