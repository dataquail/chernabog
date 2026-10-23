#!/usr/bin/env bun
// The chernabog command line.

import { describeError } from "@chernabog/sdk";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as Arr from "effect/Array";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Stdio from "effect/Stdio";

import { attachCommand, runSessions } from "./agents.ts";
import { stopHook } from "./agents/stop-hook.ts";
import { Home } from "./config.ts";
import { RELOAD_EXIT_CODE, runDaemon } from "./daemon.ts";
import { doctor, formatCheck } from "./doctor.ts";
import { runLogFile } from "./engine.ts";
import { Exec } from "./Exec.ts";
import { GitHubTokens } from "./github-auth.ts";
import { GitHubApi } from "./GitHubApi.ts";
import { scaffold } from "./init.ts";
import { Asker } from "./interface/cli/asker.prompt.ts";
import { showStatus, statusCommand } from "./interface/cli/daemon/status.command.ts";
import {
  enrollCommand,
  enrollFlags,
  enrollHere,
  rootOf,
} from "./interface/cli/enrollment/enroll.command.ts";
import { pauseCommand } from "./interface/cli/enrollment/pause.command.ts";
import { resumeCommand } from "./interface/cli/enrollment/resume.command.ts";
import { unenrollCommand } from "./interface/cli/enrollment/unenroll.command.ts";
import { listFlag } from "./interface/cli/list.arguments.ts";
import {
  installCommand,
  stopCommand,
  uninstallCommand,
} from "./interface/cli/machine/service.command.ts";
import { setupCommand } from "./interface/cli/machine/setup.command.ts";
import { optionalRepo, repoFlag } from "./interface/cli/repo.arguments.ts";
import { logsCommand } from "./interface/cli/runs/logs.command.ts";
import { followRunLog } from "./interface/cli/runs/run-log.output.ts";
import { trustCommand } from "./interface/cli/trust/trust.command.ts";
import { daemonReload, daemonRun, daemonTick } from "./interface/daemon/daemon.client.ts";
import type { TickResult } from "./interface/daemon/daemon.protocol.ts";
import { RunId } from "./kernel/run-id.id.ts";
import { desiredLabels, syncLabels, withFlowLabels } from "./labels.ts";
import { runLaunch } from "./launchers/shim.ts";
import { loadFlows } from "./loader.ts";
import { migrateMachineConfig } from "./migrate.ts";
import { EnrollmentLayer } from "./modules/enrollment/enrollment.layer.ts";
import { listMovedReposUseCase } from "./modules/enrollment/use-cases/list-moved-repos.use-case.ts";
import { repointRepoUseCase } from "./modules/enrollment/use-cases/repoint-repo.use-case.ts";
import { MachineLayer } from "./modules/machine/machine.layer.ts";
import { startServiceUseCase } from "./modules/machine/use-cases/start-service.use-case.ts";
import { RunLogsLayer } from "./modules/runs/runs.layer.ts";
import { resolveRunIdUseCase } from "./modules/runs/use-cases/resolve-run-id.use-case.ts";
import { type ActiveRun, type RunView } from "./modules/runs/use-cases/run.result.ts";
import { TrustLayer } from "./modules/trust/trust.layer.ts";
import { openPr } from "./open-pr.ts";
import { IMPLICIT } from "./persona.ts";
import { HostEnvironment } from "./platform/environment.ts";
import {
  chooseRecipes,
  diffRecipes,
  docsOf,
  installedRecipes,
  installRecipes,
  recipeNamed,
  RECIPES,
} from "./recipes.ts";
import { findEnrolled, loadMachineConfig, loadRepo } from "./repo-config.ts";
import { repoConfigDir, runInForeground } from "./runner.ts";
import { openSession, startIssue } from "./start.ts";
import { runStepChild, StepServicesLive } from "./steps.ts";
import { runTui } from "./tui/app.ts";
import { VERSION } from "./version.ts";

const printLines = (lines: Iterable<string>) =>
  Effect.forEach(lines, (line) => Console.log(line), { discard: true });

const fail = (message: string) =>
  Effect.gen(function* () {
    yield* Console.error(message);
    process.exitCode = 1;
  });

const suffix = (value: Option.Option<string>, prefix: string) =>
  Option.match(value, { onNone: () => "", onSome: (text) => `${prefix}${text}` });

const start = Command.make(
  "start",
  {
    issue: Argument.Int("issue").pipe(
      Argument.withDescription(
        "An issue to work on with an agent, on the hybrid path; left out, start the daemon",
      ),
      Argument.optional,
    ),
    repo: Flag.String("repo").pipe(
      Flag.withDescription(
        "The enrolled repo the issue is in, by name or owner/name; the one this directory is in when left out",
      ),
      Flag.optional,
    ),
    as: Flag.String("as").pipe(
      Flag.withDescription(
        "The GitHub persona that authors the work, for a repo that runs as several",
      ),
      Flag.optional,
    ),
  },
  ({ as, issue, repo }) =>
    Effect.gen(function* () {
      if (Option.isSome(issue)) {
        return yield* startIssue(issue.value, repo, as);
      }

      yield* startServiceUseCase();
      yield* Console.log("started");
    }),
).pipe(
  Command.withDescription(
    "Start the daemon; with an issue, open a session where you and an agent work on it, and chernabog takes the pull request to review",
  ),
);

const openPrCommand = Command.make(
  "open-pr",
  {
    title: Flag.String("title").pipe(
      Flag.withDescription("The pull request title, following the repo commit convention"),
    ),
    body: Flag.String("body").pipe(
      Flag.withDescription("The pull request body in Markdown, without the Closes line"),
      Flag.optional,
    ),
    bodyFile: Flag.String("body-file").pipe(
      Flag.withDescription("A file holding the pull request body, instead of --body"),
      Flag.optional,
    ),
    summary: Flag.String("summary").pipe(
      Flag.withDescription(
        "What changed and how it was tested, for the issue; the title when left out",
      ),
      Flag.optional,
    ),
  },
  (options) => Effect.flatMap(openPr(options), printLines),
).pipe(
  Command.withDescription(
    "From the session chernabog start opened: hand the committed work to chernabog, which pushes it, opens the pull request, waits for CI and asks for a review",
  ),
);

const daemon = Command.make("daemon", {}, () =>
  Effect.gen(function* () {
    const code = yield* runDaemon;

    if (code === RELOAD_EXIT_CODE) {
      process.exitCode = code;
    }
  }),
).pipe(
  Command.withDescription(
    "Run the daemon in the foreground (the service runs this; it logs to daemon.log in the chernabog home)",
  ),
);

const reportFinished = (finished: Option.Option<RunView | ActiveRun>) =>
  Effect.gen(function* () {
    if (Option.isNone(finished)) {
      return;
    }

    yield* Console.log(
      `${finished.value.status}: ${Option.getOrElse(finished.value.summary, () => "")}`,
    );

    if (finished.value.status === "failed") {
      process.exitCode = 1;
    }
  });

const followStarted = (result: TickResult, detach: boolean) =>
  Effect.gen(function* () {
    const runId = Arr.head(result.started);

    if (Option.isNone(runId)) {
      return yield* Console.log(
        Option.getOrElse(
          result.skipped,
          () => "nothing to start: the trigger found no work without a run already in flight",
        ),
      );
    }

    yield* Console.log(`started ${runId.value}, log: ${yield* runLogFile(runId.value)}`);

    if (detach) {
      return;
    }

    yield* reportFinished(yield* followRunLog(RunId.make(runId.value)));
  });

const asFlag = Flag.String("as").pipe(
  Flag.withDescription("The GitHub persona to act as, for a flow that runs as several"),
  Flag.optional,
);

const personaField = (persona: Option.Option<string>) =>
  Option.match(persona, { onNone: () => ({}), onSome: (login) => ({ persona: login }) });

const run = Command.make(
  "run",
  {
    flow: Argument.String("flow"),
    repo: repoFlag,
    item: Flag.String("item").pipe(
      Flag.withDescription("A work item key the trigger reports, such as issue-12"),
      Flag.optional,
    ),
    fromCheckout: Flag.Boolean("from-checkout").pipe(
      Flag.withDescription(
        "Run in this process with the working copy's .chernabog/, to try a change (the daemon must be stopped)",
      ),
      Flag.withDefault(false),
    ),
    detach: Flag.Boolean("detach").pipe(
      Flag.withDescription("Start the run and return without following its log"),
      Flag.withDefault(false),
    ),
    as: asFlag,
  },
  ({ as, detach, flow, fromCheckout, item, repo }) =>
    Effect.gen(function* () {
      if (!fromCheckout) {
        const viaDaemon = yield* Effect.result(
          daemonRun({ repo, flow, item, ...personaField(as) }),
        );

        if (Result.isSuccess(viaDaemon)) {
          return yield* followStarted(viaDaemon.success, detach);
        }

        // Refused, the daemon is running and said no; unavailable, run here instead.
        if (Predicate.isTagged(viaDaemon.failure, "DaemonRefused")) {
          return yield* fail(viaDaemon.failure.message);
        }
      }

      yield* reportFinished(
        yield* runInForeground({ repo, flow, item, fromCheckout, persona: as }),
      );
    }),
).pipe(
  Command.withDescription(
    "One run of a flow now, skipping gates; through the daemon when it is running",
  ),
);

const trigger = Command.make(
  "trigger",
  { flow: Argument.String("flow"), repo: repoFlag, as: asFlag },
  ({ as, flow, repo }) =>
    Effect.gen(function* () {
      const result = yield* daemonTick({ repo, flow, item: Option.none(), ...personaField(as) });

      const said = Option.match(Option.liftPredicate(result.started, Arr.isReadonlyArrayNonEmpty), {
        onNone: () => Option.getOrElse(result.skipped, () => "nothing to start"),
        onSome: (started) => `started ${started.join(", ")}`,
      });

      yield* Console.log(said);
    }),
).pipe(
  Command.withDescription("Run a flow's tick now, with its gates, as if its schedule came due"),
);

const targetsOf = (repo: Option.Option<string>) =>
  Effect.gen(function* () {
    const machine = yield* loadMachineConfig;

    if (Option.isSome(repo)) {
      return { machine, targets: [yield* findEnrolled(machine, repo.value)] };
    }

    return { machine, targets: machine.repos };
  });

const doctorCommand = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const checks = yield* doctor;
    yield* printLines(checks.map(formatCheck));

    if (checks.some((check) => !check.ok)) {
      process.exitCode = 1;
    }
  }),
).pipe(Command.withDescription("Check logins, gh scopes, labels, trust and the daemon"));

const labels = Command.make(
  "labels",
  {
    repo: optionalRepo,
    fromCheckout: Flag.Boolean("from-checkout").pipe(
      Flag.withDescription(
        "Read the labels from the working copy's .chernabog/, to create them before it is merged",
      ),
      Flag.withDefault(false),
    ),
  },
  ({ fromCheckout, repo }) =>
    Effect.gen(function* () {
      const { machine, targets } = yield* targetsOf(repo);

      for (const enrolled of targets) {
        const { configDir } = yield* repoConfigDir(enrolled, fromCheckout);
        const { settings } = yield* loadRepo(machine, enrolled, configDir);
        const flows = yield* loadFlows(configDir);
        yield* Console.log(
          yield* syncLabels(
            enrolled.repo,
            withFlowLabels(desiredLabels(settings.labels), flows.values()),
          ),
        );
      }
    }),
).pipe(
  Command.withDescription("Create or correct each repo's labels, and those its flows declare"),
);

// In a terminal, whether the person agrees; elsewhere, no.
const confirmed = (message: string) =>
  Effect.gen(function* () {
    const asker = yield* Asker;

    if (!asker.interactive) {
      return false;
    }

    return (
      (yield* asker.choose(message, [
        { title: "Yes", value: "yes" },
        { title: "No", value: "no" },
      ])) === "yes"
    );
  });

// A checkout that moved: its entry in machine config still names where it
// was. Offers to point the entry here, settings and all, and says whether any
// such entry was left where it was.
const offerRepoint = (root: string) =>
  Effect.gen(function* () {
    let declined = false;

    for (const entry of (yield* listMovedReposUseCase(root)).repos) {
      if (
        !(yield* confirmed(
          `${entry.name} (${entry.repo}) is enrolled at ${entry.path}, which is gone. Point it here, keeping its settings?`,
        ))
      ) {
        yield* Console.log(
          `${entry.name} is enrolled at ${entry.path}, which is gone; chernabog enroll${suffix(entry.named, " --name ")} here points it here, keeping its settings`,
        );
        declined = true;
        continue;
      }

      yield* repointRepoUseCase(entry.path, root);
      yield* Console.log(`pointed ${entry.name} at ${root}`);
      yield* daemonReload.pipe(Effect.ignore);
    }

    return declined;
  });

const RECIPES_LIST = RECIPES.map((recipe) => recipe.name).join(", ");

const recipesFlag = listFlag(
  "recipes",
  `Recipes to bake into .chernabog/flows/, comma-separated: ${RECIPES_LIST}. Asked in a terminal; none otherwise`,
);

// Bakes the chosen recipes into the repo at `root`, and says what it wrote.
const bakeRecipes = (root: string, named: Option.Option<ReadonlyArray<string>>) =>
  Effect.gen(function* () {
    const recipes = yield* chooseRecipes(named, yield* installedRecipes(root));
    yield* printLines(yield* installRecipes(root, recipes));
  });

const init = Command.make(
  "init",
  { path: Argument.String("path").pipe(Argument.optional), recipes: recipesFlag, ...enrollFlags },
  ({ path, recipes, ...flags }) =>
    Effect.gen(function* () {
      const root = yield* rootOf(path);
      const written = yield* scaffold(root);

      yield* printLines(
        Option.match(Option.liftPredicate(written, Arr.isReadonlyArrayNonEmpty), {
          onNone: () => [".chernabog/ is already set up; nothing written"],
          onSome: (files) => files.map((file) => `wrote ${file}`),
        }),
      );

      yield* bakeRecipes(root, recipes);

      // Enrolling would point a moved entry here after all, so a checkout that
      // isn't the moved one enrolls only under a name of its own.
      if ((yield* offerRepoint(root)) && Option.isNone(flags.name)) {
        yield* Console.log(
          "Not enrolled: to run this checkout alongside the one that moved, chernabog enroll --name <another name> here",
        );

        return;
      }

      // Enrolling chooses among the repo's flows, so a repo with none waits for one.
      yield* enrollHere(root, flags).pipe(
        Effect.flatMap((repo) =>
          Console.log(
            `Next: commit .chernabog/ if it's new and merge it to the base branch, then chernabog trust ${repo.name}.`,
          ),
        ),
        Effect.catchTag("NoFlows", () =>
          Console.log(
            `Not enrolled: .chernabog/flows/ has no flows. Add recipes with chernabog recipes add (${RECIPES_LIST}), or write a flow, then chernabog enroll here.`,
          ),
        ),
      );
    }),
).pipe(
  Command.withDescription(
    "Scaffold .chernabog/ in a repo, bake the recipes you choose into its flows, enroll it on this machine, and point a moved checkout's settings at it",
  ),
);

const recipesList = Command.make(
  "list",
  { path: Argument.String("path").pipe(Argument.optional) },
  ({ path }) =>
    Effect.gen(function* () {
      const installed = yield* installedRecipes(yield* rootOf(path));

      for (const recipe of RECIPES) {
        let mark = " ";

        if (installed.includes(recipe)) {
          mark = "✓";
        }

        yield* printLines([
          `${mark} ${recipe.name}: ${recipe.description}`,
          `    ${docsOf(recipe)}`,
        ]);
      }
    }),
).pipe(Command.withDescription("List the recipes, with a check by each one the repo has"));

const recipesAdd = Command.make(
  "add",
  {
    names: Argument.String("recipe").pipe(
      Argument.withDescription(
        `Recipes to bake: ${RECIPES_LIST}. Asked in a terminal when none is named`,
      ),
      Argument.variadic(),
    ),
  },
  ({ names }) =>
    Effect.gen(function* () {
      const root = yield* rootOf(Option.none());
      const named = Option.liftPredicate(names, Arr.isReadonlyArrayNonEmpty);

      // Checked first, so a typo is said before anything is asked.
      for (const name of Option.getOrElse(named, (): ReadonlyArray<string> => [])) {
        yield* recipeNamed(name);
      }

      const recipes = yield* chooseRecipes(named, yield* installedRecipes(root));
      const lines = yield* installRecipes(root, recipes);

      if (lines.length === 0) {
        return yield* Console.log("Nothing added");
      }

      yield* printLines(lines);
      yield* Console.log(
        "Next: commit and merge them to the base branch, chernabog trust the repo, and chernabog enroll here to choose which personas run them.",
      );
    }),
).pipe(
  Command.withDescription(
    "Bake recipes into this repo's .chernabog/flows/, never overwriting a flow it has",
  ),
);

const recipesDiff = Command.make(
  "diff",
  {
    names: Argument.String("recipe").pipe(
      Argument.withDescription("Recipes to compare; every one the repo has when none is named"),
      Argument.variadic(),
    ),
  },
  ({ names }) =>
    Effect.gen(function* () {
      yield* Console.log(`Against the recipes of chernabog ${VERSION}:`);
      yield* printLines(yield* diffRecipes(yield* rootOf(Option.none()), names));
    }),
).pipe(
  Command.withDescription(
    "Show how this repo's flows differ from the current versions of the recipes they came from",
  ),
);

const recipesCommand = Command.make("recipes", {}, () => Effect.void).pipe(
  Command.withDescription("Complete flows to bake into a repo, as code it then owns"),
  Command.withSubcommands([recipesList, recipesAdd, recipesDiff]),
);

const attach = Command.make("attach", { run: Argument.String("run") }, ({ run: named }) =>
  Effect.gen(function* () {
    const { runId } = yield* resolveRunIdUseCase(named);
    const session = Arr.last(yield* runSessions(runId));

    if (Option.isNone(session)) {
      return yield* fail(`${runId} has opened no agent session`);
    }

    const command = yield* attachCommand(session.value);
    yield* Console.log(
      `Attaching to ${session.value.adapter} session ${session.value.sessionId} in ${command.cwd}`,
    );
    yield* openSession(command).pipe(Effect.catch((error) => fail(error.message)));
  }),
).pipe(
  Command.withDescription(
    "Open a run's agent session in the agent's own interactive UI, in its worktree",
  ),
);

const stepChild = Command.make("__step", {}, () =>
  runStepChild.pipe(Effect.provide(StepServicesLive)),
);

// What a launcher runs: the agent, in the foreground of its terminal.
const launchChild = Command.make("__launch", { spec: Argument.String("spec") }, ({ spec }) =>
  Effect.map(runLaunch(spec), (code) => {
    process.exitCode = code;
  }),
);

// Claude's Stop hook in an interactive session.
const stopHookChild = Command.make(
  "__stop-hook",
  { dir: Flag.String("dir"), person: Flag.Boolean("person").pipe(Flag.withDefault(false)) },
  ({ dir, person }) =>
    Effect.flatMap(
      stopHook(dir, person),
      Option.match({ onNone: () => Effect.void, onSome: Console.log }),
    ),
);

// With no subcommand, in a terminal: the live view. Piped, the status instead.
const live = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;

  if (yield* stdio.stdoutIsTerminal) {
    return yield* runTui;
  }

  return yield* showStatus(false);
});

export const chernabog = Command.make("chernabog", {}, () => live).pipe(
  Command.withDescription("Spends spare coding-agent capacity on queued work across your repos"),
  Command.withSubcommands([
    statusCommand,
    attach,
    run,
    trigger,
    openPrCommand,
    logsCommand,
    pauseCommand,
    resumeCommand,
    trustCommand,
    labels,
    doctorCommand,
    setupCommand,
    init,
    recipesCommand,
    enrollCommand,
    unenrollCommand,
    installCommand,
    uninstallCommand,
    start,
    stopCommand,
    daemon,
    Command.unlisted(stepChild),
    Command.unlisted(launchChild),
    Command.unlisted(stopHookChild),
  ]),
);

const PlatformLive = Layer.mergeAll(BunServices.layer, HostEnvironment.layer, Home.layer);

// One GitHubTokens for the process, so each persona's token is looked up once.
const AppLive = Layer.mergeAll(EnrollmentLayer, TrustLayer, RunLogsLayer, MachineLayer).pipe(
  Layer.provideMerge(Layer.mergeAll(GitHubApi.layerFor(IMPLICIT), Asker.layer)),
  Layer.provideMerge(GitHubTokens.layer),
  Layer.provideMerge(Layer.mergeAll(Exec.layer, FetchHttpClient.layer)),
  Layer.provideMerge(PlatformLive),
);

// Machine config from before each persona's settings lived there is brought
// up to date before any command reads it. Not being able to is said, not fatal:
// the command then reports the config as it finds it.
const migrated = migrateMachineConfig.pipe(
  Effect.flatMap((lines) =>
    Effect.forEach(lines, (line) => Console.error(`chernabog: machine config: ${line}`), {
      discard: true,
    }),
  ),
  Effect.catch((error) =>
    Console.error(`chernabog: could not update machine config: ${describeError(error)}`),
  ),
);

if (import.meta.main) {
  migrated.pipe(
    Effect.andThen(Command.run(chernabog, { version: VERSION })),
    Effect.catch((error) => fail(`chernabog: ${describeError(error)}`)),
    Effect.provide(AppLive),
    BunRuntime.runMain({ disableErrorReporting: true }),
  );
}
