import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { effectAtHome } from "../../../../../test/effect-test.ts";
import { Home } from "../../../../platform/home.ts";
import { AccountDirsClient } from "../../domain/ports/clients/account-dirs.client.ts";
import { AccountDirsClientLive } from "./account-dirs.client-live.ts";

describe("AccountDirsClientLive", () => {
  effectAtHome("finds claude's and codex's directories in the home, and nothing else", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = (yield* Home).user;

      for (const name of [".codex", ".claude-personal", ".opencode", "code", "a/.claude"]) {
        yield* fs.makeDirectory(`${home}/${name}`, { recursive: true });
      }

      yield* fs.writeFileString(`${home}/.claude-notes`, "a file, not a login");
      const dirs = yield* AccountDirsClient;

      expect(yield* dirs.home).toBe(home);
      expect(yield* dirs.found).toEqual([`${home}/.claude-personal`, `${home}/.codex`]);
      expect(yield* dirs.exists(`${home}/code`)).toBe(true);
      expect(yield* dirs.exists(`${home}/nope`)).toBe(false);
    }).pipe(Effect.provide(AccountDirsClientLive)),
  );
});
