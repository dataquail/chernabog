// A throwaway repo with the scaffolded .chernabog/ and the review loop's
// recipes (or the ones a test names) on its base branch, a fake
// GitHub for it (refs in a local bare repo), a fake `claude` on PATH, and the
// CLI pointed at all of it.

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Json } from "@chernabog/sdk";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import YAML from "yaml";

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
};

const REVIEW_LOOP = ["implement", "review", "re-review", "address-review"];

export type CliResult = { readonly code: number; readonly output: string };

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
        baseBranch: "main",
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

  for (const key of ["agents", "launcher", "launchers", "events"] as const) {
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
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.yaml"), machineConfigText(root, checkout, machine));
  // The work account's login off macOS, where nothing asks fakebin/security for it.
  mkdirSync(join(root, "claude"), { recursive: true });
  writeFileSync(
    join(root, "claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "fake-token", expiresAt: 4102444800000 } }),
  );
  const fakeGitHub = startFakeGitHub({ slug: SLUG, bare });

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

  const env = {
    ...process.env,
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
    FAKE_CODEX_LOG: join(root, "codex.log"),
    FAKE_OPENCODE_LOG: join(root, "opencode.log"),
    FAKE_TMUX_STATE: join(root, "tmux"),
    FAKE_TMUX_LOG: join(root, "tmux.log"),
    FAKE_ORCA_STATE: join(root, "orca"),
    FAKE_ORCA_LOG: join(root, "orca.log"),
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

  // The CLI as a machine with this home and checkout runs it.
  const cliOn =
    (machineHome: string, machineCheckout: string) =>
    (args: ReadonlyArray<string>, extraEnv: Readonly<Record<string, string>> = {}) =>
      // From the sandbox's root once a test has moved the checkout away.
      spawn(program, [...programArgs, ...args], {
        env: { ...env, CHERNABOG_HOME: machineHome, ...extraEnv },
        cwd: Option.getOrElse(Option.liftPredicate(machineCheckout, existsSync), () => root),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

  const collecting =
    (spawnCli: ReturnType<typeof cliOn>) =>
    (args: ReadonlyArray<string>, extraEnv: Readonly<Record<string, string>> = {}) =>
      new Promise<CliResult>((resolve) => {
        const child = spawnCli(args, extraEnv);
        let output = "";

        const collect = (chunk: Buffer) => {
          output += chunk.toString();
        };

        child.stdout.on("data", collect);
        child.stderr.on("data", collect);

        // Killed by a signal, a child has no exit code.
        child.on("close", (code) => {
          resolve({ code: code ?? -1, output });
        });
      });

  const cli = cliOn(home, checkout);
  const runCli = collecting(cli);

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

  return {
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
    git,
    env,
  };
};

export type Sandbox = ReturnType<typeof openSandbox>;

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
