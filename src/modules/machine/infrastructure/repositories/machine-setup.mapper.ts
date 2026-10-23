// A machine's setup as machine config stores it: github: by login, and
// accounts: by name, each with its config directory and, when it isn't
// claude, its agent. The rest of an account's settings are the person's, and
// saving never touches an account it didn't add.

import * as Option from "effect/Option";
import type YAML from "yaml";

import { type MachineConfigFile } from "../../../../repo-config.ts";
import { MachineAccount } from "../../domain/machine-setup/machine-account.value-object.ts";
import { MachineSetupRoot } from "../../domain/machine-setup/machine-setup.root.ts";

// The keys of machine config a setup reads.
export type SetupFile = Pick<MachineConfigFile, "github" | "accounts">;

export const toRoot = (file: SetupFile) =>
  MachineSetupRoot.make({
    personas: Object.keys(file.github ?? {}),
    accounts: Object.entries(file.accounts ?? {}).map(([name, account]) =>
      MachineAccount.make({
        name,
        agent: account.agent ?? "claude",
        configDir: Option.flatten(Option.fromUndefinedOr(account.configDir)),
      }),
    ),
    accountsWritten: Option.isSome(Option.fromUndefinedOr(file.accounts)),
  });

const accountNode = (account: MachineAccount) => ({
  ...Option.match(account.configDir, {
    onNone: () => ({}),
    onSome: (configDir) => ({ configDir }),
  }),
  ...Option.match(
    Option.liftPredicate(account.agent, (agent) => agent !== "claude"),
    { onNone: () => ({}), onSome: (agent) => ({ agent }) },
  ),
});

// Writes what changed between two setups onto machine config's document.
export const applySetup = (
  document: YAML.Document,
  before: MachineSetupRoot,
  after: MachineSetupRoot,
) => {
  for (const login of before.personas.filter((known) => !after.personas.includes(known))) {
    document.deleteIn(["github", login]);
  }

  for (const login of after.personas.filter((known) => !before.personas.includes(known))) {
    document.setIn(["github", login], document.createNode({}));
  }

  const names = (setup: MachineSetupRoot) => setup.accounts.map((account) => account.name);

  if (before.accountsWritten) {
    for (const name of names(before).filter((known) => !names(after).includes(known))) {
      document.deleteIn(["accounts", name]);
    }
  }

  for (const account of after.accounts.filter(
    (candidate) => !before.accountsWritten || !names(before).includes(candidate.name),
  )) {
    document.setIn(["accounts", account.name], document.createNode(accountNode(account)));
  }
};
