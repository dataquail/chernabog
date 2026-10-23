import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { MachineAccount } from "../domain/machine-setup/machine-account.value-object.ts";
import { MachineSetupRoot } from "../domain/machine-setup/machine-setup.root.ts";
import { AccountDirsClientFake } from "../infrastructure/clients/account-dirs.client-fake.ts";
import { GitHubLoginsClientFake } from "../infrastructure/clients/github-logins.client-fake.ts";
import { MachineSetupsRepositoryFake } from "../infrastructure/repositories/machine-setups.repository-fake.ts";
import { planSetupUseCase } from "./plan-setup.use-case.ts";

const HOME = "/home/zw";

const setupOf = (personas: ReadonlyArray<string>, accounts: ReadonlyArray<MachineAccount>) =>
  MachineSetupRoot.make({ personas, accounts, accountsWritten: accounts.length > 0 });

const work = MachineAccount.make({ name: "work", agent: "claude", configDir: Option.none() });

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

describe("planSetupUseCase", () => {
  effect("offers gh's logins and the account directories no account names yet", () =>
    Effect.gen(function* () {
      const plan = yield* planSetupUseCase();

      expect(plan.loggedIn).toEqual(["alice", "bob"]);
      expect(plan.personas).toEqual(["bob"]);
      expect(plan.candidates.map((found) => [found.display, found.agent])).toEqual([
        ["~/.claude-personal", Option.some("claude")],
        ["~/.codex", Option.some("codex")],
      ]);
    }).pipe(
      Effect.provide(
        machine(
          setupOf(["bob"], [work]),
          ["alice", "bob"],
          [".claude", ".claude-personal", ".codex"],
        ),
      ),
    ),
  );
});
