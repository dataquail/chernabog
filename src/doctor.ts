// `chernabog doctor`: checks logins, gh scopes, labels, trust and the daemon,
// and says how to fix what is wrong.

import { type Account, DEFAULT_LABELS, type ResolvedLauncher } from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { checkCodexAccount } from "./codex-usage.ts";
import { Home } from "./config.ts";
import { Exec, type ExecResult } from "./Exec.ts";
import {
  decodeManifest,
  describeDrift,
  describeTooOld,
  isTooOld,
  pinDrift,
  requiredVersion,
} from "./flow-deps.ts";
import { canMerge, githubGetAllPages, viewerLoginAs } from "./GitHubApi.ts";
import { daemonStatus } from "./interface/daemon/daemon.client.ts";
import { RepoSlug } from "./kernel/repo-slug.id.ts";
import { desiredLabels, Label, planLabelSync } from "./labels.ts";
import { describeLauncher, launcherFor } from "./launchers.ts";
import { flowNames } from "./loader.ts";
import { findTrustedTreeUseCase } from "./modules/trust/use-cases/find-trusted-tree.use-case.ts";
import { asSuffix } from "./persona.ts";
import { HostEnvironment } from "./platform/environment.ts";
import {
  type EffectiveRepo,
  type EnrolledRepo,
  flowOff,
  loadMachineConfig,
  loadRepo,
  type MachineAccount,
  type MachineConfig,
  repoNameOf,
} from "./repo-config.ts";
import { isInstalled } from "./service.ts";
import { configTree, snapshotConfig } from "./snapshot.ts";
import { checkAccount, loggedInEmail } from "./usage-gate.ts";
import { VERSION } from "./version.ts";

export type Check = {
  readonly ok: boolean;
  readonly label: string;
  readonly fix: Option.Option<string>;
};

const markOf = (ok: boolean) => {
  if (ok) {
    return "✓";
  }

  return "✗";
};

export const formatCheck = (check: Check) => {
  const mark = markOf(check.ok);

  return `${mark} ${check.label}${Option.match(check.fix, { onNone: () => "", onSome: (fix) => `\n    fix: ${fix}` })}`;
};

const LabelsPage = Schema.Array(Label);

const notRun: ExecResult = { exitCode: 127, stdout: "", stderr: "" };

const when = (condition: boolean, text: string) =>
  Option.getOrElse(
    Option.liftPredicate(text, () => condition),
    () => "",
  );

const homeOf = (account: MachineAccount, fallback: string) =>
  Option.getOrElse(account.configDir, () => fallback);

// The accounts some enrolled repo spends: its own, or the first one.
const accountsInUse = (machine: MachineConfig) =>
  machine.accounts.filter((candidate) =>
    machine.repos.some((repo) =>
      Option.contains(
        Option.orElse(Option.fromUndefinedOr(repo.account), () =>
          Option.map(Arr.head(machine.accounts), (first) => first.name),
        ),
        candidate.name,
      ),
    ),
  );

const ClaudeState = Schema.fromJsonString(
  Schema.Struct({
    projects: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.Struct({ hasTrustDialogAccepted: Schema.optionalKey(Schema.Boolean) }),
      ),
    ),
  }),
);

// The path and every folder above it, up to the root.
const ancestorsOf = (path: string) => {
  const parts = path.split("/").filter((part) => part.length > 0);

  return [...parts.map((_, index) => `/${parts.slice(0, parts.length - index).join("/")}`), "/"];
};

// An interactive session stops at "do you trust this folder?" unless Claude
// trusts the checkout or a folder above it; its worktrees inherit that trust.
export const claudeTrusts = (account: Account, path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;

    const file = Option.match(account.configDir, {
      onNone: () => `${home.user}/.claude.json`,
      onSome: (dir) => `${dir}/.claude.json`,
    });

    const state = yield* Schema.decodeEffect(ClaudeState)(yield* fs.readFileString(file));
    const projects = state.projects ?? {};

    return ancestorsOf(path).some((folder) =>
      Option.exists(
        Record.get(projects, folder),
        (project) => project.hasTrustDialogAccepted === true,
      ),
    );
  }).pipe(Effect.orElseSucceed(() => false));

// Each GitHub persona: gh has its login, and GitHub says the token is its. A
// persona pushes over https with its token; over ssh, git uses this machine's
// key, whoever the persona.
const checkPersonas = (
  machine: MachineConfig,
  check: (ok: boolean, label: string, fix: string) => void,
) =>
  Effect.gen(function* () {
    const exec = yield* Exec;

    for (const login of machine.github) {
      const answered = yield* Effect.result(viewerLoginAs(Option.some(login)));

      const said = Result.match(answered, {
        onSuccess: (found) => found,
        onFailure: (error) => error.message,
      });

      check(
        Result.isSuccess(answered) && answered.success.toLowerCase() === login.toLowerCase(),
        `gh is logged in as ${login} (GitHub says: ${said})`,
        `gh auth login --hostname github.com, as ${login}, then gh auth switch back to your usual account`,
      );
    }

    if (machine.github.length === 0) {
      return;
    }

    for (const repo of machine.repos) {
      const origin = yield* exec
        .run("git", ["-C", repo.path, "remote", "get-url", "origin"])
        .pipe(Effect.orElseSucceed(() => notRun));

      const url = origin.stdout.trim();
      check(
        url.startsWith("https://"),
        `${repoNameOf(repo)}: origin is https (${url}), so each persona pushes as itself`,
        `git -C ${repo.path} remote set-url origin https://github.com/${repo.repo}.git`,
      );
    }
  });

export const doctor = Effect.gen(function* () {
  const exec = yield* Exec;
  const fs = yield* FileSystem.FileSystem;
  const checks: Array<Check> = [];

  const check = (ok: boolean, label: string, fix: string) => {
    checks.push({ ok, label, fix: Option.liftPredicate(fix, () => !ok) });
  };

  const gh = yield* exec
    .run("gh", ["auth", "status"])
    .pipe(Effect.orElseSucceed((): ExecResult => ({ ...notRun, stderr: "gh not found" })));

  const scopes = Option.getOrElse(
    Option.flatMap(
      Option.fromNullishOr(/Token scopes: (.*)/.exec(`${gh.stdout}${gh.stderr}`)),
      (match) => Option.fromUndefinedOr(match[1]),
    ),
    () => "",
  );

  check(gh.exitCode === 0, "gh is logged in", "gh auth login");
  check(scopes.includes("'repo'"), "gh's token has the repo scope", "gh auth refresh -s repo");

  const machine = yield* loadMachineConfig;

  yield* checkPersonas(machine, check);

  check(
    machine.repos.length > 0,
    `${machine.repos.length} repo(s) enrolled`,
    "chernabog enroll, in a repo with .chernabog/ on its base branch",
  );

  for (const account of accountsInUse(machine)) {
    if (account.agent === "codex") {
      const codex = yield* Effect.result(checkCodexAccount(account));

      const who = Option.match(Result.getSuccess(codex), {
        onNone: () => "",
        onSome: (said) => ` (${said})`,
      });

      check(
        Result.isSuccess(codex),
        `the ${account.name} account is logged in to Codex${who}`,
        `CODEX_HOME=${homeOf(account, "~/.codex")} codex login`,
      );
      continue;
    }

    if (account.agent !== "claude") {
      continue;
    }

    if (Option.isSome(account.oauthTokenEnv)) {
      const token = yield* Effect.result(checkAccount(account));

      const who = Option.match(Result.getSuccess(token), {
        onNone: () => "",
        onSome: (said) => ` (${said})`,
      });

      check(
        Result.isSuccess(token),
        `the ${account.name} account has its token${who}; Claude checks it when a session starts`,
        `${account.oauthTokenEnv.value}=$(claude setup-token)`,
      );
      check(
        account.usageGate === "none",
        `the ${account.name} account runs without a usage gate, which its token cannot read`,
        `add usageGate: none to the ${account.name} account`,
      );
      continue;
    }

    const email = yield* loggedInEmail(account).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    );

    const expected = account.expectedEmail;

    const matches =
      Option.isSome(email) &&
      Option.match(expected, { onNone: () => true, onSome: (wanted) => email.value === wanted });

    const as = Option.match(email, { onNone: () => "", onSome: (found) => ` as ${found}` });

    const asExpected = Option.match(expected, {
      onNone: () => "",
      onSome: (wanted) => ` (as ${wanted})`,
    });

    check(
      matches,
      `the ${account.name} account is logged in${as}`,
      `CLAUDE_CONFIG_DIR=${homeOf(account, "~/.claude")} claude auth login${asExpected}`,
    );
  }

  const host = yield* HostEnvironment;
  check(
    !Record.has(host.variables, "ANTHROPIC_API_KEY"),
    "no ANTHROPIC_API_KEY in the environment (runs stay on subscription billing)",
    "unset ANTHROPIC_API_KEY; Chernabog removes it from agent runs regardless",
  );

  const launchersInUse = new Map<string, ResolvedLauncher>();

  // The flows each persona runs: the ones machine config lists for it. Not a failure when none do.
  const checkFlows = (effective: EffectiveRepo, name: string, configDir: string) =>
    Effect.gen(function* () {
      const names = yield* flowNames(configDir).pipe(
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      );

      for (const own of effective.personas) {
        const on = names.filter((flow) => Option.isNone(flowOff(own, flow)));

        const runs = Option.match(Option.liftPredicate(on, Arr.isReadonlyArrayNonEmpty), {
          onNone: () => "runs none of its flows",
          onSome: (flows) => `runs ${flows.join(", ")}`,
        });

        check(true, `${name}${asSuffix(own.persona)}: ${runs}`, "");
      }
    });

  // Each of the team's reviewers that this machine acts as can merge: the
  // reviewer merges an approved auto:ship pull request.
  const checkReviewers = (repo: EnrolledRepo, name: string, reviewers: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      for (const login of machine.github.filter((own) =>
        reviewers.some((reviewer) => reviewer.toLowerCase() === own.toLowerCase()),
      )) {
        const access = yield* Effect.result(canMerge(repo.repo, login));

        const said = Result.match(access, {
          onSuccess: (found) => found.permission,
          onFailure: (error) => error.message,
        });

        check(
          Result.isSuccess(access) && access.success.ok,
          `${name}: reviewer ${login} can merge in ${repo.repo} (${said})`,
          `give ${login} write access to ${repo.repo}, or take it out of reviewers: in .chernabog/config.yaml`,
        );
      }
    });

  // Where the repo's interactive sessions run for each persona, whether that tool works, and whether Claude will open its worktrees without asking.
  const checkLauncher = (repo: EnrolledRepo, name: string, baseBranch: string) =>
    Effect.gen(function* () {
      const loaded = yield* Effect.result(
        Effect.flatMap(snapshotConfig(repo.path, baseBranch, false), (snapshot) =>
          loadRepo(machine, repo, snapshot.configDir),
        ),
      );

      if (Result.isFailure(loaded)) {
        check(
          false,
          `${name}: config loads (${loaded.failure.message})`,
          "fix the setting it names; a launcher is chosen on the repo's entry in machine config or machine config's own launcher:, within the repo's allowedLaunchers",
        );

        return;
      }

      yield* checkFlows(loaded.success, name, loaded.success.settings.configDir);
      yield* checkReviewers(repo, name, loaded.success.settings.reviewers ?? []);
      const trusted = new Set<string>();

      for (const { persona, settings } of loaded.success.personas) {
        check(true, `${name}${asSuffix(persona)}: launcher ${describeLauncher(settings)}`, "");

        if (settings.agent !== "claude") {
          continue;
        }

        if (Option.isNone(launcherFor(settings.launcher))) {
          check(true, `${name}${asSuffix(persona)}: runs use claude -p (launcher headless)`, "");

          continue;
        }

        launchersInUse.set(settings.launcher.name, settings.launcher);

        if (trusted.has(settings.account.name)) {
          continue;
        }

        trusted.add(settings.account.name);
        const configDir = Option.getOrElse(settings.account.configDir, () => "~/.claude");
        check(
          yield* claudeTrusts(settings.account, repo.path),
          `${name}: Claude trusts ${repo.path}, so its worktrees open without a prompt`,
          `cd ${repo.path} && CLAUDE_CONFIG_DIR=${configDir} claude, then choose "Yes, I trust this folder"`,
        );
      }
    });

  // Whether an editor types the repo's flows against this binary's SDK and effect. A snapshot that fails is checkLauncher's to report.
  const checkPins = (repo: EnrolledRepo, name: string, baseBranch: string) =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.result(snapshotConfig(repo.path, baseBranch, false));

      if (Result.isFailure(snapshot)) {
        return;
      }

      const path = `${snapshot.success.configDir}/package.json`;

      if (!(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false)))) {
        check(
          false,
          `${name}: .chernabog/package.json pins the SDK and effect for editors`,
          "chernabog init, then commit .chernabog/package.json and tsconfig.json",
        );

        return;
      }

      const manifest = yield* Effect.result(
        Effect.flatMap(fs.readFileString(path), decodeManifest),
      );

      if (Result.isFailure(manifest)) {
        check(
          false,
          `${name}: ${manifest.failure.message}`,
          "fix .chernabog/package.json on the base branch",
        );

        return;
      }

      const required = yield* Effect.result(requiredVersion(manifest.success));

      if (Result.isFailure(required)) {
        check(
          false,
          `${name}: ${required.failure.message}`,
          "fix .chernabog/package.json on the base branch",
        );

        return;
      }

      const floor = required.success;

      if (Option.isSome(floor) && isTooOld(floor.value)) {
        check(
          false,
          `${name}: ${describeTooOld(floor.value)}`,
          `install chernabog ${floor.value} or newer`,
        );

        // Its pins aren't drift to fix: this binary can't load the repo at all.
        return;
      }

      const label = Option.match(floor, {
        onNone: () => `${name}: .chernabog/package.json names the oldest chernabog it runs on`,
        onSome: (oldest) =>
          `${name}: .chernabog/ runs on this chernabog (${VERSION}; needs ${oldest} or newer)`,
      });

      check(
        Option.isSome(floor),
        label,
        "chernabog init sets engines.chernabog in .chernabog/package.json; commit it",
      );

      const drift = pinDrift(manifest.success);
      const differs = when(drift.length > 0, ` (${drift.map(describeDrift).join(", ")})`);
      check(
        drift.length === 0,
        `${name}: .chernabog/package.json pins this binary's SDK and effect${differs}`,
        "chernabog init updates the pins; commit them, then reinstall in .chernabog/",
      );
    });

  for (const repo of machine.repos) {
    const name = repoNameOf(repo);
    const baseBranch = repo.baseBranch ?? "main";

    if (!(yield* fs.exists(repo.path).pipe(Effect.orElseSucceed(() => false)))) {
      check(
        false,
        `${name}: checkout exists at ${repo.path}`,
        `clone ${repo.repo} there, run chernabog init where it lives now to point its settings there, or chernabog unenroll ${repo.repo}`,
      );
      continue;
    }

    const tree = yield* Effect.result(configTree(repo.path, baseBranch));

    if (Result.isFailure(tree)) {
      check(
        false,
        `${name}: .chernabog/ is on ${baseBranch}`,
        "chernabog init, then commit and merge .chernabog/",
      );
      continue;
    }

    check(
      Option.contains((yield* findTrustedTreeUseCase(RepoSlug.make(repo.repo))).tree, tree.success),
      `${name}: .chernabog/ (${tree.success.slice(0, 8)}) is trusted`,
      `chernabog trust ${name}`,
    );

    yield* checkLauncher(repo, name, baseBranch);
    yield* checkPins(repo, name, baseBranch);

    const labels = yield* githubGetAllPages(
      `/repos/${repo.repo}/labels?per_page=100`,
      LabelsPage,
      (page) => page,
    ).pipe(Effect.option);

    if (Option.isNone(labels)) {
      check(false, `${name}: labels can be read`, `gh repo view ${repo.repo}`);
      continue;
    }

    const missing = planLabelSync(labels.value, desiredLabels(DEFAULT_LABELS)).filter(
      (change) => change.action === "create",
    );

    check(
      missing.length === 0,
      `${name}: labels exist${when(missing.length > 0, ` (missing ${missing.map((change) => change.label.name).join(", ")})`)}`,
      `chernabog labels ${name}`,
    );
  }

  for (const resolved of launchersInUse.values()) {
    for (const launcher of Option.toArray(launcherFor(resolved))) {
      const tool = yield* launcher.check;
      check(tool.ok, tool.label, tool.fix);
    }
  }

  const agentsInUse = new Set(accountsInUse(machine).map((account) => account.agent));

  for (const agent of agentsInUse) {
    const command = Option.getOrElse(
      Option.flatMap(Record.get(machine.agents, agent), (configured) =>
        Option.flatMap(Option.fromUndefinedOr(configured.start), Arr.head),
      ),
      () => agent,
    );

    const version = yield* exec
      .run(command, ["--version"])
      .pipe(Effect.orElseSucceed(() => notRun));

    const firstLine = Option.getOrElse(
      Option.liftPredicate(version.stdout.trim().split("\n")[0] ?? "", (line) => line.length > 0),
      () => command,
    );

    check(
      version.exitCode === 0,
      `${agent}: ${firstLine}`,
      `install ${command}, and make sure it is on the PATH the daemon was installed with`,
    );
  }

  check(yield* isInstalled, "the daemon service is installed", "chernabog install");

  const status = yield* Effect.result(daemonStatus);

  const pid = Option.match(Result.getSuccess(status), {
    onNone: () => "",
    onSome: (running) => ` (pid ${running.pid})`,
  });

  check(Result.isSuccess(status), `the daemon is running${pid}`, "chernabog start");

  return checks;
});
