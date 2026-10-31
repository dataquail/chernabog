import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effectAtHome } from "../../../../test/effect-test.ts";
import { Home } from "../../../platform/home.ts";
import { MachineAccount } from "../domain/machine-setup/machine-account.value-object.ts";
import { MachineSetupRoot } from "../domain/machine-setup/machine-setup.root.ts";
import { MachineSetupsRepository } from "../domain/machine-setup/machine-setups.repository.ts";
import { AccountDirsClientLive } from "../infrastructure/clients/account-dirs.client-live.ts";
import { GitHubLoginsClientFake } from "../infrastructure/clients/github-logins.client-fake.ts";
import { MachineSetupsRepositoryLive } from "../infrastructure/repositories/machine-setups.repository-live.ts";
import { planSetupHandler } from "./plan-setup.handler.ts";

const work = MachineAccount.make({ name: "work", agent: "claude", configDir: Option.none() });

// gh's logins stay scripted: the test can't sign in to GitHub.
const machine = (logins: ReadonlyArray<string>) =>
  Layer.mergeAll(
    MachineSetupsRepositoryLive,
    AccountDirsClientLive,
    GitHubLoginsClientFake(logins),
  );

describe("planSetupHandler", () => {
  effectAtHome("offers gh's logins and the account directories no account names yet", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = (yield* Home).user;

      for (const dir of [".claude", ".claude-personal", ".codex"]) {
        yield* fs.makeDirectory(`${home}/${dir}`, { recursive: true });
      }

      yield* (yield* MachineSetupsRepository).upsertOne(
        MachineSetupRoot.make({ personas: ["bob"], accounts: [work], accountsWritten: true }),
      );

      const plan = yield* planSetupHandler();

      expect(plan.loggedIn).toEqual(["alice", "bob"]);
      expect(plan.personas).toEqual(["bob"]);
      expect(plan.accountsWritten).toBe(true);
      expect(plan.candidates.map((found) => [found.display, found.agent])).toEqual([
        ["~/.claude-personal", Option.some("claude")],
        ["~/.codex", Option.some("codex")],
      ]);
    }).pipe(Effect.provide(machine(["alice", "bob"]))),
  );
});
