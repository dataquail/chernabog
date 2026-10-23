// The rules setting up a machine keeps: which GitHub personas it acts as, and
// the accounts it adds, their names and how machine config writes them. Each
// op takes the setup as it is and returns it as it should be; storing it,
// with the file's comments, is the repository's job.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";

import { MachineAccount } from "./machine-account.value-object.ts";
import { NotLoggedIn, PersonaStillInUse } from "./machine-setup.errors.ts";
import { MachineSetupRoot } from "./machine-setup.root.ts";

// The agents an account directory's name says it belongs to.
const AGENT_DIR = /^\.?(claude|codex|opencode)(?:-[\w.-]+)?$/;

// Where each agent keeps its login when an account names no configDir.
const DEFAULT_DIRS: Readonly<Record<string, string>> = { claude: "~/.claude", codex: "~/.codex" };

const baseName = (path: string) => path.replace(/\/+$/, "").split("/").at(-1) ?? path;

// A path as written, with ~ for `home`.
const expandHome = (path: string, home: string) => {
  if (path === "~") {
    return home;
  }

  if (path.startsWith("~/")) {
    return `${home}${path.slice(1)}`;
  }

  return path;
};

// A directory as the person's home spells it, such as ~/.claude-personal.
const homeRelative = (dir: string, home: string) => {
  if (dir.startsWith(`${home}/`)) {
    return `~${dir.slice(home.length)}`;
  }

  return dir;
};

// The agent an account directory's name says it's for: ~/.claude-personal is claude's.
const agentOfDir = (path: string) =>
  Option.map(Option.fromNullishOr(AGENT_DIR.exec(baseName(path))), (match) => match[1]);

// The directories this machine's accounts keep their logins in, in full.
const knownDirs = (setup: MachineSetupRoot, home: string) =>
  setup.accounts.flatMap((account) =>
    Option.toArray(
      Option.map(
        Option.orElse(account.configDir, () => Record.get(DEFAULT_DIRS, account.agent)),
        (dir) => expandHome(dir, home),
      ),
    ),
  );

// A name for a new account: its directory's, such as claude-personal for
// ~/.claude-personal, numbered past the names taken.
const nameFor = (dir: string, taken: ReadonlyArray<string>) => {
  const base = baseName(dir).replace(/^\./, "");
  let name = base;

  for (let count = 2; taken.includes(name); count++) {
    name = `${base}-${count}`;
  }

  return name;
};

// The default account a machine config without accounts: has.
const WORK = MachineAccount.make({ name: "work", agent: "claude", configDir: Option.none() });

// An account to add: its directory, in full, and the agent it's for.
export type NewAccount = { readonly dir: string; readonly agent: string };

// Adds accounts, each named for its directory. A machine that had only the
// default work account keeps it, so repos that name it keep it.
const addAccounts = (setup: MachineSetupRoot, adding: ReadonlyArray<NewAccount>, home: string) => {
  const added: Array<MachineAccount> = [];

  for (const { agent, dir } of adding) {
    added.push(
      MachineAccount.make({
        name: nameFor(
          dir,
          [...setup.accounts, ...added].map((account) => account.name),
        ),
        agent,
        configDir: Option.some(homeRelative(dir, home)),
      }),
    );
  }

  if (added.length === 0) {
    return { setup, added };
  }

  const existing = Option.getOrElse(
    Option.liftPredicate(setup.accounts, () => setup.accountsWritten),
    () => [WORK],
  );

  return {
    setup: MachineSetupRoot.make({
      ...setup,
      accounts: [...existing, ...added],
      accountsWritten: true,
    }),
    added,
  };
};

// The personas a person chose, of the logins gh has, replacing the ones
// before; refused when an enrolled repo still runs as one it drops.
const choosePersonas = (
  setup: MachineSetupRoot,
  chosen: ReadonlyArray<string>,
  loggedIn: ReadonlyArray<string>,
  inUse: ReadonlyArray<string>,
): Result.Result<MachineSetupRoot, NotLoggedIn | PersonaStillInUse> => {
  const unknown = chosen.filter((login) => !loggedIn.includes(login));

  if (unknown.length > 0) {
    return Result.fail(new NotLoggedIn({ logins: unknown, loggedIn }));
  }

  const dropped = Arr.dedupe(inUse).filter((login) => !chosen.includes(login));

  if (dropped.length > 0) {
    return Result.fail(new PersonaStillInUse({ logins: dropped }));
  }

  return Result.succeed(MachineSetupRoot.make({ ...setup, personas: Arr.dedupe(chosen) }));
};

// Adds personas without dropping any, such as one whose gh login lapsed.
const addPersonas = (setup: MachineSetupRoot, logins: ReadonlyArray<string>) =>
  MachineSetupRoot.make({ ...setup, personas: Arr.dedupe([...setup.personas, ...logins]) });

export const MachineSetupRootOps = {
  expandHome,
  homeRelative,
  agentOfDir,
  knownDirs,
  nameFor,
  addAccounts,
  choosePersonas,
  addPersonas,
} as const;
