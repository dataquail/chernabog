import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effectAtHome } from "../../../../test/effect-test.ts";
import { Home } from "../../../platform/home.ts";
import { AccountDirsClientLive } from "../infrastructure/clients/account-dirs.client-live.ts";
import { inspectAccountDirHandler } from "./inspect-account-dir.handler.ts";

describe("inspectAccountDirHandler", () => {
  effectAtHome("reads ~ as the home, and says the agent when the name tells it", () =>
    Effect.gen(function* () {
      const home = (yield* Home).user;
      const told = yield* inspectAccountDirHandler({ typed: " ~/elsewhere/.claude-work " });
      const untold = yield* inspectAccountDirHandler({ typed: "~/elsewhere/.work-claude" });

      expect([told.dir, told.display, told.agent]).toEqual([
        `${home}/elsewhere/.claude-work`,
        "~/elsewhere/.claude-work",
        Option.some("claude"),
      ]);
      expect(untold.agent).toEqual(Option.none());
    }).pipe(Effect.provide(AccountDirsClientLive)),
  );
});
