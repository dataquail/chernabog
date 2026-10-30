import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { effect } from "../../../../test/effect-test.ts";
import { type MachineAccount } from "../domain/machine-setup/machine-account.value-object.ts";
import { MachineSetupRoot } from "../domain/machine-setup/machine-setup.root.ts";
import { AccountDirsClientFake } from "../infrastructure/clients/account-dirs.client-fake.ts";
import { GitHubLoginsClientFake } from "../infrastructure/clients/github-logins.client-fake.ts";
import { MachineSetupsRepositoryFake } from "../infrastructure/repositories/machine-setups.repository-fake.ts";
import { readMachineSetupHandler } from "./read-machine-setup.handler.ts";

const HOME = "/home/zw";

const setupOf = (personas: ReadonlyArray<string>, accounts: ReadonlyArray<MachineAccount>) =>
  MachineSetupRoot.make({ personas, accounts, accountsWritten: accounts.length > 0 });

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

describe("readMachineSetupHandler", () => {
  effect(
    "lists the personas and accounts, and the default work account when none are written",
    () =>
      Effect.gen(function* () {
        const view = yield* readMachineSetupHandler();

        expect(view.personas).toEqual(["alice"]);
        expect(view.accounts).toEqual([{ name: "work", agent: "claude" }]);
      }).pipe(Effect.provide(machine(setupOf(["alice"], []), [], []))),
  );
});
