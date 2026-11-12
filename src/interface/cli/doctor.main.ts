// `chernabog doctor`: checks logins, gh scopes, labels, trust, the rulesets
// that protect progress records, a CI repo's workflow and secrets, and the
// daemon, and says how to fix what is wrong.

import { type Account, type ResolvedLauncher } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { providedRange } from "../../kernel/core-support.value-object.ts";
import { asSuffix } from "../../kernel/persona.value-object.ts";
import { RepoSlug } from "../../kernel/repo-slug.id.ts";
import { MachineQueries } from "../../modules/machine/machine.platform.ts";
import { RecipesCommands } from "../../modules/recipes/recipes.platform.ts";
import {
  checkAccount,
  checkCodexAccount,
  checkThreadsSetup,
  CI_SECRETS,
  CI_WORKFLOW_FILE,
  CiWorkflow,
  ciWorkflowFor,
  declaredLabels,
  describeLauncher,
  flowWarnings,
  Label,
  launcherFor,
  loggedInEmail,
  personalRepo,
  planLabelSync,
  setupFix,
  type ThreadsSetup,
} from "../../modules/runs/runs.platform.ts";
import { TrustQueries } from "../../modules/trust/trust.platform.ts";
import { type Backup, listBackups } from "../../platform/backups.ts";
import { IncompatibleConfig } from "../../platform/config-error.ts";
import { configBranch, configTree, snapshotConfig } from "../../platform/config-snapshot.ts";
import { HostEnvironment } from "../../platform/environment.ts";
import { Exec, type ExecResult } from "../../platform/exec.ts";
import {
  checkRunnable,
  decodeManifest,
  describeDrift,
  pinDrift,
  UPGRADE_COMMAND,
} from "../../platform/flow-deps.ts";
import {
  describeSource,
  flowNames,
  type FlowSource,
  flowSources,
  loadFlows,
} from "../../platform/flow-loader.ts";
import {
  canMerge,
  GitHubApi,
  githubGetAllPages,
  viewerLoginAs,
} from "../../platform/github-api.ts";
import { Home } from "../../platform/home.ts";
import { VERSION } from "../../platform/version.ts";
import {
  type EffectiveRepo,
  type EnrolledRepo,
  flowOff,
  loadCiConfig,
  loadMachineConfig,
  loadRepo,
  type MachineAccount,
  type MachineConfig,
  readRepoWorkflows,
  repoNameOf,
  workflowYaml,
} from "../../repo-config.ts";
import { daemonStatus } from "../daemon/daemon.client.ts";
import { printJson, printLines } from "./cli.output.ts";
import { jsonFlag } from "./output.arguments.ts";

// A warning passes, as doctor's exit code goes, but says what may need doing.
export type Check = {
  readonly ok: boolean;
  readonly warning: boolean;
  readonly label: string;
  readonly fix: Option.Option<string>;
};

const markOf = (check: Check) => {
  if (check.warning) {
    return "!";
  }

  if (check.ok) {
    return "✓";
  }

  return "✗";
};

export const formatCheck = (check: Check) => {
  const mark = markOf(check);

  return `${mark} ${check.label}${Option.match(check.fix, { onNone: () => "", onSome: (fix) => `\n    fix: ${fix}` })}`;
};

const LabelsPage = Schema.Array(Label);

const SecretsPage = Schema.Struct({
  secrets: Schema.Array(Schema.Struct({ name: Schema.String })),
});

const notRun: ExecResult = { exitCode: 127, stdout: "", stderr: "" };

const when = (condition: boolean, text: string) =>
  Option.getOrElse(
    Option.liftPredicate(text, () => condition),
    () => "",
  );

// What `recipes compile --check` made of one flow document.
type CheckedDocument = {
  readonly flow: string;
  readonly outcome: "wrote" | "unchanged" | "stale" | "problems";
  readonly problems: ReadonlyArray<{
    readonly file: string;
    readonly line: number;
    readonly column: number;
    readonly path: string;
    readonly message: string;
  }>;
};

// A flow file that isn't what its document compiles to is what the daemon
// runs all the same, so it's a warning, as is a document with problems, which
// can't be compared at all. One up to date says nothing.
export const flowDocumentWarnings = (name: string, flows: ReadonlyArray<CheckedDocument>) =>
  flows.flatMap(({ flow, outcome, problems }) => {
    if (outcome === "stale") {
      return [
        {
          label: `${name}: .chernabog/flows/${flow}.ts isn't what its flow document compiles to; the daemon runs the flow file`,
          fix: `chernabog recipes compile ${flow}, or, if the flow file was edited by hand, move the edit into .chernabog/documents/ and compile it`,
        },
      ];
    }

    if (outcome !== "problems") {
      return [];
    }

    const first = Option.match(Arr.head(problems), {
      onNone: () => "",
      onSome: (problem) =>
        ` (${[
          `${problem.file}:${problem.line}:${problem.column}`,
          // A problem of the document as a whole has no path to say.
          ...Option.toArray(Option.liftPredicate(problem.path, (path) => path !== "")),
          problem.message,
        ].join(": ")}${when(problems.length > 1, `, and ${problems.length - 1} more`)})`,
    });

    return [
      {
        label: `${name}: the ${flow} flow document has problems, so its flow file can't be checked against it${first}`,
        fix: `chernabog recipes compile ${flow} says where each one is; fix them in the document`,
      },
    ];
  });

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

type ClaudeProjects = NonNullable<Schema.Schema.Type<typeof ClaudeState>["projects"]>;

// Whether Claude opens a git checkout without asking "do you trust this
// folder?". For a git repo it looks up the repo's own path, not a folder above
// it, and a worktree of the repo inherits its trust wherever the worktree is
// (Claude Code 2.1.322, #465): a trusted ~/code covers neither.
export const trustsCheckout = (projects: ClaudeProjects, path: string) =>
  Option.exists(Record.get(projects, path), (project) => project.hasTrustDialogAccepted === true);

// An interactive session stops at "do you trust this folder?" unless Claude
// trusts the checkout itself; its worktrees, under the chernabog home, inherit
// that trust.
export const claudeTrusts = (account: Account, path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;

    const file = Option.match(account.configDir, {
      onNone: () => `${home.user}/.claude.json`,
      onSome: (dir) => `${dir}/.claude.json`,
    });

    const state = yield* Schema.decodeEffect(ClaudeState)(yield* fs.readFileString(file));
    const real = yield* fs.realPath(path).pipe(Effect.orElseSucceed(() => path));

    return [path, real].some((each) => trustsCheckout(state.projects ?? {}, each));
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

// The labels a repo's flows declare, from its config branch; none when they don't load.
const declaredOn = (machine: MachineConfig, repo: EnrolledRepo) =>
  Effect.flatMap(snapshotConfig(repo.path, false), (snapshot) =>
    Effect.flatMap(
      Effect.all({
        effective: loadRepo(machine, repo, snapshot.configDir),
        flows: loadFlows(snapshot.configDir),
      }),
      ({ effective, flows }) => declaredLabels(effective, flows),
    ),
  ).pipe(Effect.option);

export const doctor = Effect.gen(function* () {
  const exec = yield* Exec;
  const fs = yield* FileSystem.FileSystem;
  const checks: Array<Check> = [];

  const check = (ok: boolean, label: string, fix: string) => {
    checks.push({ ok, warning: false, label, fix: Option.liftPredicate(fix, () => !ok) });
  };

  const warn = (label: string, fix: string) => {
    checks.push({ ok: true, warning: true, label, fix: Option.some(fix) });
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
    "chernabog enroll, in a repo with .chernabog/ on its default branch",
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

      const sources = yield* flowSources(configDir).pipe(
        Effect.orElseSucceed(() => new Map<string, FlowSource>()),
      );

      // An imported flow says where it comes from: deploy · @acme/recipes@2.1.0.
      const named = (flow: string) =>
        `${flow}${Option.getOrElse(
          Option.map(
            Option.fromUndefinedOr(sources.get(flow)),
            (source) => ` · ${describeSource(source)}`,
          ),
          () => "",
        )}`;

      for (const own of effective.personas) {
        const on = names.filter((flow) => Option.isNone(flowOff(own, flow)));

        const runs = Option.match(Option.liftPredicate(on, Arr.isReadonlyArrayNonEmpty), {
          onNone: () => "runs none of its flows",
          onSome: (flows) => `runs ${flows.map(named).join(", ")}`,
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

  // What one persona found of the threads. Whether the repo has the rulesets
  // is the same for every persona, so it is said once.
  const reportThreads = (name: string, who: string, found: ThreadsSetup, fix: string) => {
    const once = (label: string, fixed: string) => {
      if (!checks.some((said) => said.label === label)) {
        warn(label, fixed);
      }
    };

    if (found.status === "unavailable") {
      once(
        `${name}: progress records on chernabog/threads/* can't be protected: ${found.reason}; they are written unprotected`,
        "a private repo needs GitHub Team (an organization's) or Pro (a person's) for rulesets, or make it public",
      );

      return;
    }

    if (found.status === "unprotected") {
      once(
        `${name}: progress records on chernabog/threads/* are unprotected (no ruleset holds ${found.missing.join(", ")})`,
        fix,
      );

      return;
    }

    if (Option.isNone(found.writes)) {
      warn(`${name}${who}: GitHub won't say whether it may write progress records`, fix);

      return;
    }

    check(
      found.writes.value,
      `${name}${who}: rulesets protect progress records on chernabog/threads/*, and it may write them`,
      fix,
    );
  };

  // Whether rulesets protect the threads that record each item's progress
  // (chernabog/threads/*), and whether each persona may still write there. The
  // record is the binary's, so the binary checks it, whatever the flows do.
  // Missing rulesets are a warning: writes still work, unprotected. A persona
  // the rulesets refuse fails, since its progress writes would.
  const checkThreads = (repo: EffectiveRepo, name: string, slug: string) =>
    Effect.gen(function* () {
      for (const { persona } of repo.personas) {
        const asPersona = <A, E>(effect: Effect.Effect<A, E, GitHubApi>) =>
          Effect.scoped(
            Effect.flatMap(Layer.build(GitHubApi.layerFor(persona)), (api) =>
              Effect.provideContext(effect, api),
            ),
          );

        const found = yield* Effect.result(asPersona(checkThreadsSetup(slug)));
        const who = asSuffix(persona);

        if (Result.isFailure(found)) {
          warn(
            `${name}${who}: progress records' rulesets couldn't be read (${found.failure.message})`,
            "chernabog doctor again once GitHub answers",
          );
          continue;
        }

        const personal = yield* asPersona(personalRepo(slug)).pipe(
          Effect.orElseSucceed(() => false),
        );

        reportThreads(name, who, found.success, setupFix(slug, personal));
      }
    });

  // What the repo's flows check of this machine, each warning with its fix.
  // A warning passes, since another person's machine may serve what this one
  // doesn't. The implicit persona is whoever gh says. A repo whose flows
  // don't load says so elsewhere.
  const checkFlowDiagnostics = (effective: EffectiveRepo, name: string, configDir: string) =>
    Effect.gen(function* () {
      const flows = yield* Effect.option(loadFlows(configDir));

      for (const loaded of Option.toArray(flows)) {
        const warnings = yield* flowWarnings(effective, loaded, machine.github, (persona) =>
          Option.match(persona, {
            onSome: (login) => Effect.succeedSome(login),
            onNone: () => Effect.option(viewerLoginAs(Option.none())),
          }),
        );

        for (const { persona, warning } of warnings) {
          warn(`${name}${asSuffix(persona)}: ${warning.warning}`, warning.fix);
        }
      }
    });

  // Whether each flow file is what its document compiles to, as `recipes
  // compile --check` says, of the snapshot the daemon runs.
  const checkFlowDocuments = (name: string, configDir: string) =>
    Effect.gen(function* () {
      const root = (yield* Path.Path).dirname(configDir);

      const compiled = yield* Effect.result(
        (yield* RecipesCommands).CompileFlowDocumentsCommand({ root, names: [], check: true }),
      );

      if (Result.isFailure(compiled)) {
        warn(
          `${name}: the flow documents couldn't be compiled to check their flow files (${compiled.failure.message})`,
          "chernabog recipes compile, in the checkout, says why",
        );

        return;
      }

      for (const { fix, label } of flowDocumentWarnings(name, compiled.success.flows)) {
        warn(label, fix);
      }
    });

  // A repo whose config runs flows on GitHub Actions: its workflow is what
  // its config writes, and the secrets the workflow reads exist, by name. The
  // rulesets its phase writes need are checkThreads'. A workflow that pins
  // another chernabog, and differs in nothing else, is only a warning.
  const checkCi = (repo: EnrolledRepo, name: string, configDir: string) =>
    Effect.gen(function* () {
      const ci = yield* Effect.result(loadCiConfig(configDir));

      if (Result.isFailure(ci)) {
        check(
          false,
          `${name}: ci: loads (${ci.failure.message})`,
          "fix ci: in .chernabog/config.yaml",
        );

        return;
      }

      if (ci.success.flows.length === 0) {
        return;
      }

      const write = `chernabog ci workflow --write in ${repo.path}, then commit and merge it`;

      const built = (version: string) =>
        Effect.result(
          ciWorkflowFor({
            root: repo.path,
            configDir,
            ciOf: loadCiConfig,
            version,
            workflowFiles: { read: readRepoWorkflows, text: workflowYaml },
          }),
        );

      const wanted = yield* built(VERSION);

      if (Result.isFailure(wanted)) {
        check(
          false,
          `${name}: its CI workflow can be written (${wanted.failure.message})`,
          `fix what it names, then ${write}`,
        );

        return;
      }

      const file = `${repo.path}/${CI_WORKFLOW_FILE}`;
      const found = yield* fs.readFileString(file).pipe(Effect.option);

      for (const text of Option.toArray(Option.map(wanted.success, (one) => one.text))) {
        if (Option.isNone(found)) {
          check(false, `${name}: ${CI_WORKFLOW_FILE} runs its CI flows`, write);
          continue;
        }

        if (found.value === text) {
          check(true, `${name}: ${CI_WORKFLOW_FILE} matches its config`, "");
          continue;
        }

        const pinned = Option.filter(
          CiWorkflow.pinnedVersion(found.value),
          (version) => version !== VERSION,
        );

        const olderMatches = yield* Option.match(pinned, {
          onNone: () => Effect.succeed(false),
          onSome: (version) =>
            Effect.map(built(version), (rebuilt) =>
              Result.match(rebuilt, {
                onFailure: () => false,
                onSuccess: (again) => Option.exists(again, (one) => one.text === found.value),
              }),
            ),
        });

        if (olderMatches && Option.isSome(pinned)) {
          warn(
            `${name}: ${CI_WORKFLOW_FILE} runs chernabog ${pinned.value}, and this one is ${VERSION}`,
            write,
          );
          continue;
        }

        check(false, `${name}: ${CI_WORKFLOW_FILE} matches its config`, write);
      }

      const listed = yield* Effect.result(
        githubGetAllPages(
          `/repos/${repo.repo}/actions/secrets?per_page=100`,
          SecretsPage,
          (page) => page.secrets,
        ),
      );

      if (Result.isFailure(listed)) {
        warn(
          `${name}: its Actions secrets couldn't be listed (${listed.failure.message})`,
          `gh secret list -R ${repo.repo}`,
        );

        return;
      }

      // An organization's secret the repo may read serves as well as its own.
      const shared = yield* githubGetAllPages(
        `/repos/${repo.repo}/actions/organization-secrets?per_page=100`,
        SecretsPage,
        (page) => page.secrets,
      ).pipe(Effect.orElseSucceed(() => []));

      const names = new Set([...listed.success, ...shared].map((secret) => secret.name));

      for (const secret of CI_SECRETS) {
        check(
          names.has(secret),
          `${name}: the Actions secret ${secret} exists, which its CI workflow reads`,
          `gh secret set ${secret} -R ${repo.repo}`,
        );
      }
    });

  // Where the repo's interactive sessions run for each persona, whether that tool works, and whether Claude will open its worktrees without asking.
  const checkLauncher = (repo: EnrolledRepo, name: string) =>
    Effect.gen(function* () {
      const loaded = yield* Effect.result(
        Effect.flatMap(snapshotConfig(repo.path, false), (snapshot) =>
          loadRepo(machine, repo, snapshot.configDir),
        ),
      );

      // A repo this binary can't run is checkPins' to report.
      if (Result.isFailure(loaded) && Schema.is(IncompatibleConfig)(loaded.failure)) {
        return;
      }

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
      yield* checkFlowDiagnostics(loaded.success, name, loaded.success.settings.configDir);
      yield* checkFlowDocuments(name, loaded.success.settings.configDir);
      yield* checkThreads(loaded.success, name, repo.repo);
      yield* checkCi(repo, name, loaded.success.settings.configDir);
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
          `cd ${repo.path} && CLAUDE_CONFIG_DIR=${configDir} claude, then choose "Yes, I trust this folder"; trusting a folder above the checkout isn't enough`,
        );
      }
    });

  // Whether an editor types the repo's flows against this binary's SDK and effect. A snapshot that fails is checkLauncher's to report.
  const checkPins = (repo: EnrolledRepo, name: string) =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.result(snapshotConfig(repo.path, false));

      if (Result.isFailure(snapshot)) {
        if (Schema.is(IncompatibleConfig)(snapshot.failure)) {
          check(
            false,
            `${name}: incompatible: ${snapshot.failure.message}`,
            `in ${repo.path}: ${UPGRADE_COMMAND}, or install a newer chernabog, as it says`,
          );
        }

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
          "fix .chernabog/package.json on the default branch",
        );

        return;
      }

      const compatible = yield* Effect.result(checkRunnable(snapshot.success.configDir));

      if (Result.isFailure(compatible)) {
        check(
          false,
          `${name}: incompatible: ${compatible.failure.message}`,
          Option.getOrElse(
            Option.liftPredicate("install a newer chernabog", () =>
              compatible.failure.message.endsWith("upgrade chernabog"),
            ),
            () => `in ${repo.path}: ${UPGRADE_COMMAND}, then commit and merge the result`,
          ),
        );

        // Its pins aren't drift to fix: this binary can't load the repo at all.
        return;
      }

      check(
        true,
        `${name}: .chernabog/ needs a core this chernabog provides (${providedRange})`,
        "",
      );

      const drift = pinDrift(manifest.success);
      const differs = when(drift.length > 0, ` (${drift.map(describeDrift).join(", ")})`);
      check(
        drift.length === 0,
        `${name}: .chernabog/package.json pins this binary's SDK and effect${differs}`,
        `${UPGRADE_COMMAND} moves the pins and the recipe flows; commit them, then reinstall in .chernabog/`,
      );
    });

  const trust = yield* TrustQueries;

  for (const repo of machine.repos) {
    const name = repoNameOf(repo);

    if (!(yield* fs.exists(repo.path).pipe(Effect.orElseSucceed(() => false)))) {
      check(
        false,
        `${name}: checkout exists at ${repo.path}`,
        `clone ${repo.repo} there, run chernabog init where it lives now to point its settings there, or chernabog unenroll ${repo.repo}`,
      );
      continue;
    }

    // Asked of the remote, as the daemon's snapshots do; the checks below read what this recorded.
    const branch = yield* configBranch(repo.path);
    const tree = yield* Effect.result(configTree(repo.path));

    if (Result.isFailure(tree)) {
      check(
        false,
        `${name}: .chernabog/ is on ${branch}, GitHub's default branch`,
        "chernabog init, then commit and merge .chernabog/",
      );
      continue;
    }

    check(
      Option.contains(
        (yield* trust.FindTrustedTreeQuery({ repo: RepoSlug.make(repo.repo) })).tree,
        tree.success,
      ),
      `${name}: .chernabog/ (${tree.success.slice(0, 8)}) is trusted`,
      `chernabog trust ${name}`,
    );

    yield* checkLauncher(repo, name);
    yield* checkPins(repo, name);

    const labels = yield* githubGetAllPages(
      `/repos/${repo.repo}/labels?per_page=100`,
      LabelsPage,
      (page) => page,
    ).pipe(Effect.option);

    if (Option.isNone(labels)) {
      check(false, `${name}: labels can be read`, `gh repo view ${repo.repo}`);
      continue;
    }

    // A repo whose flows don't load says so above, and has no labels to check.
    const missing = Option.match(yield* declaredOn(machine, repo), {
      onNone: () => [],
      onSome: (declared) =>
        planLabelSync(labels.value, declared).filter((change) => change.action === "create"),
    });

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

  check(
    (yield* (yield* MachineQueries).CheckServiceQuery()).installed,
    "the daemon service is installed",
    "chernabog install",
  );

  // The copies of machine config and state.db kept from before an upgrade, for rolling back.
  const root = (yield* Home).root;

  const backups = yield* Effect.all([
    listBackups(root, "config.yaml"),
    listBackups(root, "state.db"),
  ]).pipe(
    Effect.map((each) => each.flat()),
    Effect.orElseSucceed((): ReadonlyArray<Backup> => []),
  );

  check(
    true,
    Option.match(Option.liftPredicate(backups, Arr.isReadonlyArrayNonEmpty), {
      onNone: () => "no copies of machine config or state.db kept from an upgrade yet",
      onSome: (kept) =>
        `copies kept from before an upgrade, to roll back to: ${kept.map((backup) => backup.path).join(", ")}`,
    }),
    "",
  );

  const status = yield* Effect.result(daemonStatus);

  const pid = Option.match(Result.getSuccess(status), {
    onNone: () => "",
    onSome: (running) => ` (pid ${running.pid})`,
  });

  check(Result.isSuccess(status), `the daemon is running${pid}`, "chernabog start");

  return checks;
});

// The checks as JSON, for a script: each one's result, whether it's only a
// warning, and how to fix it.
const DoctorReport = Schema.Struct({
  ok: Schema.Boolean,
  checks: Schema.Array(
    Schema.Struct({
      ok: Schema.Boolean,
      warning: Schema.Boolean,
      label: Schema.String,
      fix: Schema.OptionFromNullOr(Schema.String),
    }),
  ),
});

export const doctorCommand = Command.make("doctor", { json: jsonFlag }, ({ json }) =>
  Effect.gen(function* () {
    const checks = yield* doctor;
    const ok = checks.every((check) => check.ok);

    if (json) {
      yield* printJson(DoctorReport, { ok, checks });
    } else {
      yield* printLines(checks.map(formatCheck));
    }

    if (!ok) {
      process.exitCode = 1;
    }
  }),
).pipe(
  Command.withDescription(
    "Check logins, gh scopes, labels, trust, rulesets, a CI repo's workflow and secrets, and the daemon",
  ),
);
