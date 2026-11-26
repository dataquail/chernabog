// Each Claude account's token from `claude setup-token`, kept in the chernabog
// home for the sessions that can't read the macOS Keychain: sandboxed ones
// (ADR 24, decision 7). Written atomically, readable only by the person from
// the moment it exists (0600), in a directory only the person may list (0700).

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { writeFileAtomic } from "./atomic-write.ts";
import { Home, homePaths } from "./home.ts";

// How a person gives an account its token, for a refusal to say.
export const setTokenCommand = (account: string) => `chernabog accounts set-token ${account}`;

// The account's stored token; none when it has none, or it can't be read.
export const storedClaudeToken = (account: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;

    const text = yield* fs
      .readFileString(homePaths(home.root).claudeToken(account))
      .pipe(Effect.option);

    return Option.filter(
      Option.map(text, (found) => found.trim()),
      (token) => token.length > 0,
    );
  });

export const storeClaudeToken = (account: string, token: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = homePaths((yield* Home).root);

    yield* fs.makeDirectory(paths.claudeTokens, { recursive: true });
    yield* fs.chmod(paths.claudeTokens, 0o700);
    yield* writeFileAtomic(fs, paths.claudeToken(account), token, 0o600);

    return paths.claudeToken(account);
  });
