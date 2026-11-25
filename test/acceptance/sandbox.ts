// A throwaway repo with the scaffolded .chernabog/ and the review loop's
// recipes (or the ones a test names) on its base branch, a fake
// GitHub for it (refs in a local bare repo), a fake `claude` on PATH, and the
// CLI pointed at all of it.

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Json } from "@chernabog/sdk";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import YAML from "yaml";

import { DaemonStatus } from "../../src/interface/daemon/daemon.protocol.ts";
import { RecipePackageManifest } from "../../src/modules/recipes/domain/recipe/recipe-package.value-object.ts";
import { scaffoldFiles } from "../../src/modules/recipes/infrastructure/clients/bundle.client-live.ts";
import { startFakeGitHub } from "./fake-github.ts";
import { type FakeRegistry, startFakeRegistry } from "./fake-registry.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RECIPES = join(ROOT, "packages/recipes");

// The files of the recipes named, from packages/recipes/, as copying them writes them.
export const recipeFiles = (names: ReadonlyArray<string>): Readonly<Record<string, string>> => {
  const catalog = Schema.decodeSync(Schema.fromJsonString(RecipePackageManifest))(
    readFileSync(join(RECIPES, "package.json"), "utf8"),
  ).chernabog.recipes;

  return Object.fromEntries(
    Object.entries(catalog)
      .filter(([name]) => names.includes(name))
      .flatMap(([, recipe]) => [recipe.flow, ...(recipe.prompts ?? [])])
      .map((file) => [file, readFileSync(join(RECIPES, file), "utf8")]),
  );
};

const SLUG = "dataquail/demo";

// The bun.lock installing `manifest` writes, its tarballs fetched from
// `registryUrl`; none when bun can't install it. Made by a child process with
// a fake registry of its own (lockfile.ts), so this one waits on it.
const lockfileFor = (manifest: string, registryUrl: string) => {
  const made = spawnSync(process.execPath, [join(ROOT, "test/acceptance/lockfile.ts")], {
    input: manifest,
    encoding: "utf8",
  });

  return Option.map(
    Option.liftPredicate(made.stdout, () => made.status === 0),
    (lockfile) => lockfile.replaceAll(/http:\/\/localhost:\d+\//g, registryUrl),
  );
};

// `install: null`, as config.yaml says there is no install step.
const NO_INSTALL = Schema.encodeSync(Schema.OptionFromNullOr(Schema.String))(Option.none());

export type MachineOptions = {
  // GitHub personas, and which of them run the repo.
  readonly github?: ReadonlyArray<string>;
  // Personas under github: that gh has no login for.
  readonly loggedOut?: ReadonlyArray<string>;
  readonly personas?: ReadonlyArray<string>;
  // A persona's own flows, over the repo entry's.
  readonly personaFlows?: Readonly<Record<string, Readonly<Record<string, Json>>>>;
  // The repo's flows on its entry; unset, the first command lists the team's defaults there.
  readonly flows?: Readonly<Record<string, Json>>;
  readonly accounts?: Readonly<Record<string, Json>>;
  readonly account?: string;
  readonly agents?: Readonly<Record<string, Json>>;
  readonly launcher?: string;
  readonly launchers?: Readonly<Record<string, Json>>;
  // Files under .chernabog/ beyond the scaffold's, such as a flow of the repo's own.
  readonly repoFiles?: Readonly<Record<string, string>>;
  // The recipes baked in; the review loop's four when unset.
  readonly recipes?: ReadonlyArray<string>;
  // Which events tick every persona's flows sooner than cron (#138), and each login's own.
  readonly events?: Readonly<Record<string, Json>>;
  readonly personaEvents?: Readonly<Record<string, Readonly<Record<string, Json>>>>;
  // How many runs the machine keeps in flight at once; its default of one when unset.
  readonly concurrency?: number;
};

const REVIEW_LOOP = ["implement", "review", "re-review", "address-review"];

// One call of a fake agent, as fakebin/claude and fakebin/codex log it after
// "session ".
const AgentSessionLine = Schema.fromJsonString(
  Schema.Struct({
    agent: Schema.String,
    call: Schema.Literals(["start", "resume"]),
    session: Schema.String,
    persona: Schema.OptionFromNullOr(Schema.String),
    // "HEAD" when it's on no branch.
    branch: Schema.String,
    head: Schema.String,
    cwd: Schema.String,
  }),
);

// Where an event is in the sandbox's one order of events (its event log):
// what happened before it has a smaller one.
export type Sequenced = { readonly sequence: number };

export type AgentSession = typeof AgentSessionLine.Type & Sequenced;

// A push the bare repo took: by the persona its token was for, if any, and
// the ref it moved from one commit to another (all zeros for none).
export type Push = {
  readonly by: Option.Option<string>;
  readonly before: string;
  readonly after: string;
  readonly ref: string;
} & Sequenced;

// The bare repo's post-receive hook: a "push" line in the event log per ref
// a push moved, naming the persona by fakebin/gh's token, and never the token
// itself. It runs once the refs have moved and before the push returns.
const postReceive = (log: string) =>
  [
    "#!/bin/sh",
    'case "$GH_TOKEN" in token-*) by="${GH_TOKEN#token-}" ;; *) by="-" ;; esac',
    `while read -r before after ref; do echo "push $by $before $after $ref" >> '${log}'; done`,
    "",
  ].join("\n");

// The event log's lines, oldest first, each with its kind and the rest of
// it, and where it is: its sequence. A line still being written, with no
// newline yet, isn't one.
const eventsIn = (file: string) => {
  if (!existsSync(file)) {
    return [];
  }

  return readFileSync(file, "utf8")
    .split("\n")
    .slice(0, -1)
    .map((line, sequence) => {
      const space = line.indexOf(" ");

      return { kind: line.slice(0, space), rest: line.slice(space + 1), sequence };
    });
};

// `pid` is the CLI process's own, which names the telemetry file it writes.
export type CliResult = { readonly code: number; readonly output: string; readonly pid: number };

const isSettings = (value: Json): value is Readonly<Record<string, Json>> =>
  Predicate.isObject(value) && !Array.isArray(value);

const sharedOf = (repoConfig: Readonly<Record<string, Json>>) =>
  Option.getOrElse(
    Option.filter(Option.fromUndefinedOr(repoConfig.settings), isSettings),
    () => ({}),
  );

const repoConfigText = (template: string, repoConfig: Readonly<Record<string, Json>>) => {
  const document = YAML.parseDocument(template);
  document.setIn(["settings", "install"], NO_INSTALL);
  document.setIn(["settings", "localGate"], ['test -n "$(ls change-*.txt)"']);

  for (const [key, value] of Object.entries(repoConfig).filter(([name]) => name !== "settings")) {
    document.set(key, value);
  }

  // The shared settings a test gives go over the sandbox's own, key by key.
  for (const [key, value] of Object.entries(sharedOf(repoConfig))) {
    document.setIn(["settings", key], value);
  }

  return document.toString();
};

const machineConfigText = (root: string, checkout: string, machine: MachineOptions) => {
  const document = new YAML.Document({
    accounts: {
      work: { configDir: join(root, "claude"), expectedEmail: "dev@example.com" },
      codex: { agent: "codex", configDir: join(root, "codex") },
      ...machine.accounts,
    },
    repos: [
      {
        path: checkout,
        repo: SLUG,
        name: "demo",
        account: machine.account ?? "work",
        ...Option.match(Option.fromUndefinedOr(machine.flows), {
          onNone: () => ({}),
          onSome: (flows) => ({ flows }),
        }),
        ...Option.match(Option.fromUndefinedOr(machine.personas), {
          onNone: () => ({}),
          onSome: (personas) => ({
            personas: Object.fromEntries(
              personas.map((login) => [
                login,
                Option.match(Option.fromUndefinedOr(machine.personaFlows?.[login]), {
                  onNone: () => ({}),
                  onSome: (flows) => ({ flows }),
                }),
              ]),
            ),
          }),
        }),
      },
    ],
  });

  const github = Option.fromUndefinedOr(machine.github);

  if (Option.isSome(github)) {
    document.set(
      "github",
      Object.fromEntries(
        github.value.map((login) => [
          login,
          Option.match(Option.fromUndefinedOr(machine.personaEvents?.[login]), {
            onNone: () => ({}),
            onSome: (events) => ({ events }),
          }),
        ]),
      ),
    );
  }

  for (const key of ["agents", "launcher", "launchers", "events", "concurrency"] as const) {
    const value = Option.fromUndefinedOr(machine[key]);

    if (Option.isSome(value)) {
      document.set(key, value.value);
    }
  }

  return document.toString();
};

const callsIn = (file: string) => {
  if (!existsSync(file)) {
    return [];
  }

  return readFileSync(file, "utf8").trim().split("\n");
};

// CHERNABOG_BIN tests a compiled binary instead of the source.
const chernabogCommand = () =>
  Option.match(Option.fromUndefinedOr(process.env.CHERNABOG_BIN), {
    onNone: () => [process.execPath, join(ROOT, "src/interface/cli/main.ts")],
    onSome: (bin) => [bin],
  });

// The variables that keep git's global and system config, and XDG's, under
// `dir`, as a test's processes must: a scratch HOME alone leaves git's global
// config at $XDG_CONFIG_HOME/git/config, which is the person's own.
export const gitConfigIn = (dir: string) => ({
  XDG_CONFIG_HOME: join(dir, ".config"),
  GIT_CONFIG_GLOBAL: join(dir, ".gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
});

// A runner's user, at `user`: its HOME, with git's config and XDG's inside it.
export const runnerUserEnv = (user: string) => ({ HOME: user, ...gitConfigIn(user) });

export const waitFor = async (check: () => boolean, what: string, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }

    await Bun.sleep(100);
  }
};

// Resolves when a spawned child exits.
export const closed = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    child.on("close", () => {
      resolve();
    });
  });

export const openSandbox = (
  repoConfig: Readonly<Record<string, Json>> = {},
  machine: MachineOptions = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "chernabog-e2e-"));
  const bare = join(root, "origin.git");
  const checkout = join(root, "demo");
  const home = join(root, "home");

  const git = (cwd: string, ...args: Array<string>) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd,
      encoding: "utf8",
    });

  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  execFileSync("git", ["clone", "-q", bare, checkout]);
  // The registry bun installs packages from; stopped with the fake GitHub.
  const registry: FakeRegistry = startFakeRegistry();

  // bun installs from the fake registry, into a cache of the sandbox's own.
  const registryEnv = {
    NPM_CONFIG_REGISTRY: registry.url,
    BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
  };

  const files = scaffoldFiles();

  const baked = recipeFiles(machine.recipes ?? REVIEW_LOOP);

  for (const [relative, content] of Object.entries({
    ...files,
    ...baked,
    "config.yaml": repoConfigText(files["config.yaml"], repoConfig),
    ...machine.repoFiles,
  })) {
    const path = join(checkout, ".chernabog", relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  writeFileSync(join(checkout, "README.md"), "# demo\n");

  // Its lockfile committed, as init leaves it, so a snapshot's install of the
  // SDK has one to follow. A package.json a test gives that bun can't install
  // has none.
  for (const lockfile of Option.toArray(
    lockfileFor(readFileSync(join(checkout, ".chernabog", "package.json"), "utf8"), registry.url),
  )) {
    writeFileSync(join(checkout, ".chernabog", "bun.lock"), lockfile);
  }

  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "chore: set up chernabog");
  git(checkout, "push", "-q", "origin", "main");
  // The one order of what happens from here on (#622): each event appends
  // one line to this log as it happens, in one write to a file opened for
  // appending, so the kernel puts every line after the ones written before
  // it, whichever process wrote them. The bare repo logs each push as it
  // takes it, a fake agent each call as it starts, and the fake GitHub each
  // record as it makes it, before it answers. So an event that ended before
  // another began is before it here; a line's place is its sequence.
  const eventLog = join(root, "events.log");
  // Every push from here on, logged by the bare repo as it takes it: who
  // pushed, by the persona fakebin/gh's token is for, and what moved.
  writeFileSync(join(bare, "hooks", "post-receive"), postReceive(eventLog), { mode: 0o755 });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.yaml"), machineConfigText(root, checkout, machine));
  // The work account's login off macOS, where nothing asks fakebin/security for it.
  mkdirSync(join(root, "claude"), { recursive: true });
  writeFileSync(
    join(root, "claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "fake-token", expiresAt: 4102444800000 } }),
  );

  const fakeGitHub = startFakeGitHub({
    slug: SLUG,
    bare,
    recorded: (what) => {
      appendFileSync(eventLog, `github ${what}\n`);
    },
  });

  const github = {
    ...fakeGitHub,
    stop: async () => {
      await fakeGitHub.stop();
      await registry.stop();
    },
  };

  const ghLog = join(root, "gh.log");
  const agentTokenLog = join(root, "agent-tokens.log");
  const claudeLog = join(root, "claude.log");
  const disputingFile = join(root, "disputing");
  const specChangesFile = join(root, "spec-changes");

  // Not GitHub Actions' own: on chernabog's CI it's "true", and ci run and
  // ci plan then set up the runner, its git and ~/.claude.json among it. A test
  // that wants a runner says so, with a HOME of its own.
  const { GITHUB_ACTIONS: _onActions, ...inherited } = process.env;

  const env = {
    ...inherited,
    // git's global and system config, never the person's: a process the
    // sandbox starts that writes git's global config writes the sandbox's.
    // XDG_CONFIG_HOME too, which git falls back to without a ~/.gitconfig.
    ...gitConfigIn(root),
    CHERNABOG_HOME: home,
    CHERNABOG_GITHUB_API: github.url,
    GH_TOKEN: "test-token",
    PATH: `${join(ROOT, "test/fakebin")}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    FAKE_CLAUDE_LOG: claudeLog,
    FAKE_GH_USERS: (machine.github ?? [])
      .filter((login) => !(machine.loggedOut ?? []).includes(login))
      .join(","),
    FAKE_GH_LOG: ghLog,
    FAKE_AGENT_TOKEN_LOG: agentTokenLog,
    FAKE_AGENT_SESSION_LOG: eventLog,
    FAKE_CLAUDE_DISPUTING: disputingFile,
    FAKE_CLAUDE_SPEC_CHANGES: specChangesFile,
    FAKE_CODEX_LOG: join(root, "codex.log"),
    FAKE_OPENCODE_LOG: join(root, "opencode.log"),
    FAKE_TMUX_STATE: join(root, "tmux"),
    FAKE_TMUX_LOG: join(root, "tmux.log"),
    FAKE_ORCA_STATE: join(root, "orca"),
    FAKE_ORCA_LOG: join(root, "orca.log"),
    FAKE_OPEN_LOG: join(root, "open.log"),
    CHERNABOG_USAGE_URL: `${github.url}/api/oauth/usage`,
    ...registryEnv,
  };

  // Installs a checkout's .chernabog/ (the sandbox's, unless named), as a person does to try a change from
  // the working copy (run --from-checkout, rehearse); never synchronously, as
  // this process serves the registry it installs from.
  const installCheckout = async (path = checkout) => {
    await Bun.spawn([process.execPath, "install", "--ignore-scripts"], {
      cwd: join(path, ".chernabog"),
      env: { ...env },
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
  };

  const [program = "chernabog", ...programArgs] = chernabogCommand();

  // The CLI as a machine with this home and checkout runs it, with extraEnv
  // over the sandbox's environment and the variables `unset` names left out.
  const cliOn =
    (machineHome: string, machineCheckout: string) =>
    (
      args: ReadonlyArray<string>,
      extraEnv: Readonly<Record<string, string>> = {},
      unset: ReadonlyArray<string> = [],
    ) =>
      // From the sandbox's root once a test has moved the checkout away.
      spawn(program, [...programArgs, ...args], {
        env: Object.fromEntries(
          Object.entries({ ...env, CHERNABOG_HOME: machineHome, ...extraEnv }).filter(
            ([name]) => !unset.includes(name),
          ),
        ),
        cwd: Option.getOrElse(Option.liftPredicate(machineCheckout, existsSync), () => root),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

  const collecting =
    (spawnCli: ReturnType<typeof cliOn>) =>
    (
      args: ReadonlyArray<string>,
      extraEnv: Readonly<Record<string, string>> = {},
      unset: ReadonlyArray<string> = [],
    ) =>
      new Promise<CliResult>((resolve) => {
        const child = spawnCli(args, extraEnv, unset);
        let output = "";

        const collect = (chunk: Buffer) => {
          output += chunk.toString();
        };

        child.stdout.on("data", collect);
        child.stderr.on("data", collect);

        // Killed by a signal, a child has no exit code.
        child.on("close", (code) => {
          resolve({ code: code ?? -1, output, pid: child.pid ?? -1 });
        });
      });

  const cli = cliOn(home, checkout);
  const runCli = collecting(cli);

  // What a hub does before it starts a spoke (ADR 23, decision 2, step 1),
  // standing in for #659's: records a run of `flow` on `item` in this
  // machine's state.db, as the implicit persona, and answers its id. In a
  // child process of its own, as the CLI is, through the runs module's own
  // StartRunCommand handler.
  const recordRun = (flow: string, item: Json) =>
    // Evaluated from the repo's root, so its packages resolve from there.
    execFileSync(
      process.execPath,
      [
        "-e",
        `import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { BUNDLED_CORE_VERSION } from "${ROOT}src/kernel/core-support.value-object.ts";
import { RunId } from "${ROOT}src/kernel/run-id.id.ts";
import { startRunHandler } from "${ROOT}src/modules/runs/commands/start-run.handler.ts";
import { StateAt } from "${ROOT}test/sdk-fakes.ts";

const item = JSON.parse(process.env.RECORD_ITEM);
const id = RunId.make(crypto.randomUUID());

await Effect.runPromise(
  startRunHandler({
    id,
    coreVersion: BUNDLED_CORE_VERSION,
    configTree: Option.none(),
    repo: "demo",
    persona: Option.none(),
    flow: process.env.RECORD_FLOW,
    itemKey: item.key,
    itemTitle: Option.fromUndefinedOr(item.title),
    itemUrl: Option.fromUndefinedOr(item.url),
    item: Option.some(item),
  }).pipe(
    Effect.provide(StateAt(process.env.RECORD_HOME).pipe(Layer.provideMerge(BunServices.layer))),
    Effect.scoped,
  ),
);

process.stdout.write(id);
`,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          RECORD_FLOW: flow,
          RECORD_ITEM: JSON.stringify(item),
          RECORD_HOME: home,
        },
      },
    ).trim();

  // The CLI as a hub starts a spoke on this machine: its stdin a pipe the
  // test holds open, as a hub holds a spoke's, and closes to stop it.
  const spokeCli = (args: ReadonlyArray<string>) =>
    spawn(program, [...programArgs, ...args], {
      env: { ...env, CHERNABOG_HOME: home },
      cwd: Option.getOrElse(Option.liftPredicate(checkout, existsSync), () => root),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

  // Another machine on the same GitHub, with a home and a clone of its own,
  // set up as `other` says (as this one, unless given).
  const anotherMachine = (name: string, other: MachineOptions = machine) => {
    const otherHome = join(root, `home-${name}`);
    const otherCheckout = join(root, `demo-${name}`);
    execFileSync("git", ["clone", "-q", bare, otherCheckout]);
    mkdirSync(otherHome, { recursive: true });
    writeFileSync(join(otherHome, "config.yaml"), machineConfigText(root, otherCheckout, other));
    const otherCli = cliOn(otherHome, otherCheckout);

    return {
      home: otherHome,
      checkout: otherCheckout,
      cli: otherCli,
      runCli: collecting(otherCli),
    };
  };

  // Agent starts and resumes; the Stop hook's runs are in hookCalls.
  const claudeCalls = () => callsIn(claudeLog).filter((line) => !line.startsWith("stop-hook "));
  const hookCalls = () => callsIn(claudeLog).filter((line) => line.startsWith("stop-hook "));
  const tmuxCalls = () => callsIn(join(root, "tmux.log"));
  const orcaCalls = () => callsIn(join(root, "orca.log"));
  const codexCalls = () => callsIn(join(root, "codex.log"));
  const opencodeCalls = () => callsIn(join(root, "opencode.log"));
  const daemonLog = () => callsIn(join(home, "daemon.log")).join("\n");
  const ghCalls = () => callsIn(ghLog);
  const machineConfig = join(home, "config.yaml");

  // Edits machine config as a person would, keeping the rest of it.
  const editMachine = (change: (document: YAML.Document) => void) => {
    const document = YAML.parseDocument(readFileSync(machineConfig, "utf8"));
    change(document);
    writeFileSync(machineConfig, document.toString());
  };

  const agentTokens = () => callsIn(agentTokenLog);

  // What the event log says now, from one read of it, so each part is up to
  // the same point: every call of a fake agent and every push, oldest first,
  // and each of the fake GitHub's records by what it said it recorded
  // (fake-github.ts' Recorded), at its sequence.
  const events = () => {
    const logged = eventsIn(eventLog);

    return {
      agentSessions: logged
        .filter((event) => event.kind === "session")
        .map((event): AgentSession => ({
          ...Schema.decodeSync(AgentSessionLine)(event.rest),
          sequence: event.sequence,
        })),
      pushes: logged
        .filter((event) => event.kind === "push")
        .map((event): Push => {
          const [by = "", before = "", after = "", ref = ""] = event.rest.split(" ");

          return {
            by: Option.liftPredicate(by, (login) => login !== "-"),
            before,
            after,
            ref,
            sequence: event.sequence,
          };
        }),
      records: new Map(
        logged
          .filter((event) => event.kind === "github")
          .map((event) => [event.rest, event.sequence] as const),
      ),
    };
  };

  // Every call of a fake agent, oldest first: which agent, whether it started
  // or resumed its session, as which persona, and on which branch and commit.
  const agentSessions = () => events().agentSessions;

  // Every push since the sandbox was set up, oldest first.
  const pushes = () => events().pushes;

  // The change Claude commits from now on, starting a session on `branch`, or
  // resuming one as `login`, also changes a behavior spec.
  const changeSpecOn = (branch: string) => {
    appendFileSync(specChangesFile, `branch ${branch}\n`);
  };

  const changeSpecFixingAs = (login: string) => {
    appendFileSync(specChangesFile, `fixing ${login}\n`);
  };

  // A person, `login`, pushes a commit to `branch` that changes a behavior
  // spec, from a clone of their own, as their token, so the event log says
  // whose push it was.
  const pushSpecChangeAs = (login: string, branch: string) => {
    const clone = join(root, `clone-${login}`);

    if (!existsSync(clone)) {
      execFileSync("git", ["clone", "-q", bare, clone]);
    }

    git(clone, "fetch", "-q", "origin", branch);
    git(clone, "checkout", "-q", "-B", branch, `origin/${branch}`);
    mkdirSync(join(clone, "test/features"), { recursive: true });
    appendFileSync(join(clone, "test/features/filed-work.feature"), `  # changed by ${login}\n`);
    git(clone, "add", "test/features");
    git(clone, "commit", "-q", "-m", `test: ${login} changes the spec`);
    execFileSync("git", ["push", "-q", "origin", branch], {
      cwd: clone,
      env: { ...env, GH_TOKEN: `token-${login}` },
    });
  };

  // `login` takes `label` off an issue or pull request through the API, so
  // GitHub's events name who took it off.
  const unlabelAs = async (login: string, number: number, label: string) => {
    const response = await fetch(
      `${github.url}/repos/${SLUG}/issues/${number}/labels/${encodeURIComponent(label)}`,
      { method: "DELETE", headers: { authorization: `Bearer token-${login}` } },
    );

    if (!response.ok) {
      throw new Error(`taking ${label} off #${number} answered ${response.status}`);
    }
  };

  // `login`'s agent declines what a review asks for from now on, rather than
  // addressing it.
  const disagreeAs = (login: string) => {
    appendFileSync(disputingFile, `${login}\n`);
  };

  const socket = join(home, "daemon.sock");

  // Resolves once a daemon started on this home is listening.
  const daemonReady = () => waitFor(() => existsSync(socket), "the daemon");

  // What the daemon says its status is.
  const daemonStatus = async () =>
    Schema.decodeUnknownSync(DaemonStatus)(
      await (await fetch("http://daemon/status", { unix: socket })).json(),
    );

  // Stops a daemon a test started, if it hasn't exited, printing its log
  // first with DEBUG_DAEMON set.
  const stopDaemon = async (daemon: ChildProcess) => {
    if ("DEBUG_DAEMON" in process.env) {
      process.stdout.write(`${daemonLog()}\n`);
    }

    if (Option.isNone(Option.fromNullishOr(daemon.exitCode))) {
      const exited = closed(daemon);
      daemon.kill("SIGTERM");
      await exited;
    }
  };

  // A person, `author`, opens a pull request from a branch of its own, one
  // commit on main with nothing changed: its number.
  const openPullAs = async (author: string, branch: string) => {
    const sha = git(
      bare,
      "commit-tree",
      "refs/heads/main^{tree}",
      "-p",
      "refs/heads/main",
      "-m",
      `feat: by ${author} on ${branch}`,
    ).trim();

    github.setRef(`refs/heads/${branch}`, sha);

    const response = await fetch(`${github.url}/repos/${SLUG}/pulls`, {
      method: "POST",
      headers: { authorization: `Bearer token-${author}` },
      body: JSON.stringify({ head: branch, base: "main", title: `feat: by ${author}`, body: "" }),
    });

    return Schema.decodeUnknownSync(Schema.Struct({ number: Schema.Finite }))(await response.json())
      .number;
  };

  return {
    slug: SLUG,
    root,
    bare,
    checkout,
    home,
    machineConfig,
    editMachine,
    github,
    registry,
    registryEnv,
    installCheckout,
    cli,
    runCli,
    spokeCli,
    recordRun,
    anotherMachine,
    claudeCalls,
    hookCalls,
    tmuxCalls,
    orcaCalls,
    codexCalls,
    opencodeCalls,
    daemonLog,
    ghCalls,
    agentTokens,
    agentSessions,
    pushes,
    events,
    disagreeAs,
    changeSpecOn,
    changeSpecFixingAs,
    pushSpecChangeAs,
    unlabelAs,
    daemonReady,
    daemonStatus,
    stopDaemon,
    openPullAs,
    git,
    env,
  };
};

export type Sandbox = ReturnType<typeof openSandbox>;
