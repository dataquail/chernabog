// `chernabog setup`, which `chernabog install` runs first: the GitHub personas
// this machine acts as, and the AI accounts its runs spend. It asks only what
// it has to: one login, or one account found, is chosen without asking.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Record from "effect/Record";

import { Asker } from "./ask.ts";
import { ConfigError, expandHome, Home } from "./config.ts";
import { Exec } from "./Exec.ts";
import { TOKEN_VARIABLES } from "./github-auth.ts";
import { HostEnvironment, withVariables } from "./platform/environment.ts";
import {
  editMachineConfig,
  loadMachineConfig,
  type MachineAccount,
  type MachineConfig,
} from "./repo-config.ts";

const LOGGED_IN = /Logged in to github\.com account (\S+)/g;

// The accounts gh is logged in to on github.com. Asked without GH_TOKEN, which
// gh would report instead of its own logins.
export const ghLogins = Effect.gen(function* () {
  const host = yield* HostEnvironment;

  const status = yield* (yield* Exec).run("gh", ["auth", "status", "--hostname", "github.com"], {
    env: withVariables(host.variables, {}, TOKEN_VARIABLES),
  });

  return Arr.dedupe(
    [...`${status.stdout}\n${status.stderr}`.matchAll(LOGGED_IN)].map((match) => match[1]),
  );
}).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

// The agents an account directory's name says it belongs to.
const AGENT_DIR = /^\.?(claude|codex|opencode)(?:-[\w.-]+)?$/;

// The agents that keep a login in a directory of the home directory, which setup looks for.
const FOUND_DIR = /^\.(claude|codex)(?:-[\w.-]+)?$/;

// Where each agent keeps its login when an account names no configDir.
const DEFAULT_DIRS: Readonly<Record<string, string>> = { claude: "~/.claude", codex: "~/.codex" };

const baseName = (path: string) => path.replace(/\/+$/, "").split("/").at(-1) ?? path;

export const agentOfDir = (path: string) =>
  Option.map(Option.fromNullishOr(AGENT_DIR.exec(baseName(path))), (match) => match[1]);

// An account's config directory, as the person's home spells it.
const dirOf = (account: MachineAccount, home: string) =>
  Option.orElse(account.configDir, () =>
    Option.map(Record.get(DEFAULT_DIRS, account.agent), (dir) => expandHome(dir, home)),
  );

// The agents' account directories in the home directory, such as ~/.claude and ~/.claude-personal.
export const accountDirs = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* Home;
  const found: Array<string> = [];

  for (const entry of Arr.sort(yield* fs.readDirectory(home.user), Order.String)) {
    const path = `${home.user}/${entry}`;

    if (FOUND_DIR.test(entry) && (yield* fs.stat(path)).type === "Directory") {
      found.push(path);
    }
  }

  return found;
}).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

export type SetupOptions = {
  // The GitHub logins to act as, from --persona.
  readonly personas: Option.Option<ReadonlyArray<string>>;
  // Account directories to add, from --account: dir, or dir:agent.
  readonly accounts: Option.Option<ReadonlyArray<string>>;
};

const listed = (items: ReadonlyArray<string>) =>
  Option.getOrElse(
    Option.liftPredicate(items.join(", "), (text) => text.length > 0),
    () => "none",
  );

// The logins a repo's entry runs as, which setup can't drop from github:.
const loginsInUse = (machine: MachineConfig) =>
  Arr.dedupe(machine.repos.flatMap((repo) => Object.keys(repo.personas ?? {})));

// Which of gh's logins to act as: the ones named, else the ones picked, which
// replace the rest, else the only one, which is added without dropping any,
// such as one whose gh login lapsed.
const choosePersonas = (
  machine: MachineConfig,
  logins: ReadonlyArray<string>,
  named: Option.Option<ReadonlyArray<string>>,
) =>
  Effect.gen(function* () {
    const asker = yield* Asker;

    if (Option.isSome(named)) {
      const unknown = named.value.filter((login) => !logins.includes(login));

      if (unknown.length > 0) {
        return yield* new ConfigError({
          message: `gh isn't logged in to github.com as ${unknown.join(", ")} (it is as: ${listed(logins)}); gh auth login as each first`,
        });
      }

      return Option.some(Arr.dedupe(named.value));
    }

    if (logins.length < 2) {
      return Option.map(Option.liftPredicate(logins, Arr.isReadonlyArrayNonEmpty), (only) =>
        Arr.dedupe([...machine.github, ...only]),
      );
    }

    if (!asker.interactive) {
      return Option.none();
    }

    const current = Option.liftPredicate(machine.github, Arr.isReadonlyArrayNonEmpty);

    const picked = yield* asker.pick(
      "Which GitHub accounts should chernabog act as?",
      logins.map((login) => ({
        title: login,
        value: login,
        selected: Option.match(current, {
          onNone: () => true,
          onSome: (chosen) => chosen.includes(login),
        }),
      })),
    );

    return Option.some(picked);
  });

// An account to add: its directory, and the agent it belongs to.
type NewAccount = { readonly dir: string; readonly agent: string };

const parseAccount = (spec: string, home: string) =>
  Effect.gen(function* () {
    const [dir, agent] = spec.split(":");
    const path = expandHome(dir.trim(), home);
    const found = Option.orElse(Option.fromUndefinedOr(agent), () => agentOfDir(path));

    if (Option.isNone(found)) {
      return yield* new ConfigError({
        message: `can't tell which agent ${dir} belongs to; name it as ${dir}:<agent>, such as ${dir}:claude`,
      });
    }

    if (
      !(yield* FileSystem.FileSystem.use((fs) => fs.exists(path)).pipe(
        Effect.orElseSucceed(() => false),
      ))
    ) {
      return yield* new ConfigError({
        message: `${dir} doesn't exist; log in to the agent with it first`,
      });
    }

    return { dir: path, agent: found.value } satisfies NewAccount;
  });

// Asks for accounts setup didn't find, such as ~/.claude-personal behind an alias, until none is given.
const askForMore = (home: string) =>
  Effect.gen(function* () {
    const asker = yield* Asker;
    const more: Array<NewAccount> = [];

    for (;;) {
      const answer = (yield* asker.text(
        "Another account's config directory, such as ~/.claude-personal behind an alias (enter when done)",
      )).trim();

      if (answer.length === 0) {
        return more;
      }

      const dir = expandHome(answer, home);

      const agent = yield* Option.match(agentOfDir(dir), {
        onSome: Effect.succeed,
        onNone: () =>
          asker.choose(
            `Which agent is ${answer} for?`,
            ["claude", "codex", "opencode"].map((name) => ({ title: name, value: name })),
          ),
      });

      more.push(yield* parseAccount(`${dir}:${agent}`, home));
    }
  });

// A directory as the person's home spells it, such as ~/.claude-personal.
const homeRelative = (dir: string, home: string) => {
  if (dir.startsWith(`${home}/`)) {
    return `~${dir.slice(home.length)}`;
  }

  return dir;
};

// The accounts to add: the ones named, else what's found and not set up yet,
// as the person picks them, or the only one on a machine with none yet.
const chooseAccounts = (
  machine: MachineConfig,
  named: Option.Option<ReadonlyArray<string>>,
  hasAccounts: boolean,
) =>
  Effect.gen(function* () {
    const asker = yield* Asker;
    const home = (yield* Home).user;

    if (Option.isSome(named)) {
      return yield* Effect.forEach(named.value, (spec) => parseAccount(spec, home));
    }

    const known = machine.accounts.flatMap((account) => Option.toArray(dirOf(account, home)));
    const found = (yield* accountDirs).filter((dir) => !known.includes(dir));

    const candidates = found.flatMap((dir) =>
      Option.toArray(Option.map(agentOfDir(dir), (agent): NewAccount => ({ dir, agent }))),
    );

    if (!asker.interactive) {
      if (!hasAccounts && candidates.length === 1) {
        return candidates;
      }

      return [];
    }

    let picked: ReadonlyArray<string> = [];

    if (candidates.length > 0) {
      picked = yield* asker.pick(
        "Which of these AI accounts should chernabog use?",
        candidates.map((candidate) => ({
          title: homeRelative(candidate.dir, home),
          value: candidate.dir,
          description: candidate.agent,
          selected: true,
        })),
      );
    }

    return [
      ...candidates.filter((candidate) => picked.includes(candidate.dir)),
      ...(yield* askForMore(home)),
    ];
  });

// A name for a new account: its directory's, such as claude-personal for ~/.claude-personal.
const nameFor = (dir: string, taken: ReadonlyArray<string>) => {
  const base = baseName(dir).replace(/^\./, "");
  let name = base;

  for (let count = 2; taken.includes(name); count++) {
    name = `${base}-${count}`;
  }

  return name;
};

// Asks what it has to, writes machine config, and says what it chose.
export const setup = (options: SetupOptions) =>
  Effect.gen(function* () {
    const machine = yield* loadMachineConfig;
    const home = (yield* Home).user;
    const lines: Array<string> = [];
    const logins = yield* ghLogins;
    const personas = yield* choosePersonas(machine, logins, options.personas);

    const dropped = Option.getOrElse(
      Option.map(personas, (chosen) =>
        loginsInUse(machine).filter((login) => !chosen.includes(login)),
      ),
      (): ReadonlyArray<string> => [],
    );

    if (dropped.length > 0) {
      return yield* new ConfigError({
        message: `enrolled repos still run as ${dropped.join(", ")}; keep those personas, or chernabog unenroll the repos first`,
      });
    }

    const accounts = yield* editMachineConfig((document) =>
      Effect.gen(function* () {
        const hasAccounts = document.has("accounts");
        const added = yield* chooseAccounts(machine, options.accounts, hasAccounts);

        for (const chosen of Option.toArray(personas)) {
          for (const login of machine.github.filter((known) => !chosen.includes(known))) {
            document.deleteIn(["github", login]);
          }

          for (const login of chosen.filter((known) => !machine.github.includes(known))) {
            document.setIn(["github", login], document.createNode({}));
          }
        }

        // A machine config without accounts: has the default work account, which repos may name.
        if (added.length > 0 && !hasAccounts) {
          document.setIn(["accounts", "work"], document.createNode({}));
        }

        const taken = machine.accounts.map((account) => account.name);
        const names: Array<string> = [];

        for (const { agent, dir } of added) {
          const name = nameFor(dir, [...taken, ...names]);
          names.push(name);
          document.setIn(
            ["accounts", name],
            document.createNode({
              configDir: homeRelative(dir, home),
              ...Option.match(
                Option.liftPredicate(agent, (found) => found !== "claude"),
                { onNone: () => ({}), onSome: (found) => ({ agent: found }) },
              ),
            }),
          );
        }

        return names.map(
          (name, index) =>
            `${name} (${homeRelative(added[index].dir, home)}, ${added[index].agent})`,
        );
      }),
    );

    lines.push(
      Option.match(personas, {
        onSome: (chosen) => `GitHub personas: ${chosen.join(", ")}`,
        onNone: () => {
          if (logins.length === 0) {
            return "gh is logged in to no GitHub account; runs act as GH_TOKEN, or gh's active account";
          }

          return `GitHub personas: ${listed(machine.github)} (unchanged; gh is logged in as ${logins.join(", ")}: choose with --persona)`;
        },
      }),
    );

    lines.push(`AI accounts added: ${listed(accounts)}`);

    return lines;
  });
