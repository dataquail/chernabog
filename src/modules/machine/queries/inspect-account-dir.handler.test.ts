import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { MachineSetupRoot } from "../domain/machine-setup/machine-setup.root.ts";
import { AccountDirsClientFake } from "../infrastructure/clients/account-dirs.client-fake.ts";
import { GitHubLoginsClientFake } from "../infrastructure/clients/github-logins.client-fake.ts";
import { MachineSetupsRepositoryFake } from "../infrastructure/repositories/machine-setups.repository-fake.ts";
import { inspectAccountDirHandler } from "./inspect-account-dir.handler.ts";

const HOME = "/home/zw";

const setupOf = (personas: ReadonlyArray<string>) =>
  MachineSetupRoot.make({ personas, accounts: [], accountsWritten: false });

const machine = (
  setup: MachineSetupRoot,
  logins: ReadonlyArray<string>,
  dirs: ReadonlyArray<string>,
) =>
  Layer.mergeAll(
    MachineSetupsRepositoryFake(setup),
    GitHubLoginsClientFake(logins),
    AccountDirsClientFake(
      HOME,
      dirs.map((dir) => `${HOME}/${dir}`),
    ),
  );

describe("inspectAccountDirHandler", () => {
  effect("reads ~ as the home, and says the agent when the name tells it", () =>
    Effect.gen(function* () {
      const told = yield* inspectAccountDirHandler({ typed: " ~/elsewhere/.claude-work " });
      const untold = yield* inspectAccountDirHandler({ typed: "~/elsewhere/.work-claude" });

      expect([told.dir, told.display, told.agent]).toEqual([
        "/home/zw/elsewhere/.claude-work",
        "~/elsewhere/.claude-work",
        Option.some("claude"),
      ]);
      expect(untold.agent).toEqual(Option.none());
    }).pipe(Effect.provide(machine(setupOf([]), [], []))),
  );
});
