#!/usr/bin/env bun
// The chernabog command line.

import { describeError } from "@chernabog/sdk";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as Arr from "effect/Array";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stdio from "effect/Stdio";

import { attachCommand, runSessions } from "./agents.ts";
import { stopHook } from "./agents/stop-hook.ts";
import { Asker } from "./ask.ts";
import { daemonReload, daemonRun, daemonRunRow, daemonStatus, daemonTick } from "./client.ts";
import { Home } from "./config.ts";
import { RELOAD_EXIT_CODE, runDaemon } from "./daemon.ts";
import { doctor, formatCheck } from "./doctor.ts";
import { resolveRunId, runLogFile } from "./engine.ts";
import { enrollRepo } from "./enrollment.ts";
import { Exec } from "./Exec.ts";
import { GitHubTokens } from "./github-auth.ts";
import { GitHubApi } from "./GitHubApi.ts";
import { movedEntries, repoint, repoRoot, scaffold, slugOf } from "./init.ts";
import { pauseCommand } from "./interface/cli/enrollment/pause.command.ts";
import { resumeCommand } from "./interface/cli/enrollment/resume.command.ts";
import { optionalRepo, repoArgument, repoFlag } from "./interface/cli/repo.arguments.ts";
import { trustCommand } from "./interface/cli/trust/trust.command.ts";
import { RepoSlug } from "./kernel/repo-slug.id.ts";
import { runLabel, shortRunId } from "./kernel/run-id.id.ts";
import { desiredLabels, syncLabels, withFlowLabels } from "./labels.ts";
import { runLaunch } from "./launchers/shim.ts";
import { flowNames, loadFlows } from "./loader.ts";
import { migrateMachineConfig } from "./migrate.ts";
import { EnrollmentLayer } from "./modules/enrollment/enrollment.layer.ts";
import { type ActiveRun, type RunView } from "./modules/runs/use-cases/run.result.ts";
import { TrustLayer } from "./modules/trust/trust.layer.ts";
import { findTrustedTreeUseCase } from "./modules/trust/use-cases/find-trusted-tree.use-case.ts";
import { openPr } from "./open-pr.ts";
import { asSuffix, IMPLICIT } from "./persona.ts";
import { HostEnvironment } from "./platform/environment.ts";
import type { DaemonStatus, TickResult } from "./protocol.ts";
import {
  chooseRecipes,
  diffRecipes,
  docsOf,
  installedRecipes,
  installRecipes,
  recipeNamed,
  RECIPES,
} from "./recipes.ts";
import {
  findEnrolled,
  FLOW_TURNED_OFF,
  loadMachineConfig,
  loadRepo,
  machineConfigFile,
  repoNameOf,
  unenrollFromMachineConfig,
} from "./repo-config.ts";
import { repoConfigDir, runInForeground, tailer } from "./runner.ts";
import { install, startService, stopService, uninstall } from "./service.ts";
import { setup } from "./setup.ts";
import { configTree } from "./snapshot.ts";
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

const MINUTE_MS = 60_000;

const relative = (iso: Option.Option<string>, now: DateTime.Utc) =>
  Option.match(
    Option.flatMap(iso, (text) => DateTime.make(text)),
    {
      onNone: () => "never",
      onSome: (at) => {
        const minutes = Math.round(
          (DateTime.toEpochMillis(at) - DateTime.toEpochMillis(now)) / MINUTE_MS,
        );

        if (Math.abs(minutes) < 1) {
          return "now";
        }

        if (minutes > 0) {
          return `in ${minutes}m`;
        }

        return `${-minutes}m ago`;
      },
    },
  );

const suffix = (value: Option.Option<string>, prefix: string) =>
  Option.match(value, { onNone: () => "", onSome: (text) => `${prefix}${text}` });

const when = (condition: boolean, text: string) =>
  Option.getOrElse(
    Option.liftPredicate(text, () => condition),
    () => "",
  );

const repoLine = (repo: DaemonStatus["repos"][number]) => {
  if (repo.paused) {
    return "paused";
  }

  if (!repo.enabled) {
    return "disabled";
  }

  return repo.status;
};

const runLine = (run: DaemonStatus["active"][number]) => {
  if (run.parked) {
    return "waiting";
  }

  return Option.getOrElse(run.currentStep, () => "starting");
};

export const describeStatus = (status: DaemonStatus, now: DateTime.Utc) => {
  const finished = status.recent.filter((run) => run.status !== "running");

  const upSince = Option.match(DateTime.make(status.startedAt), {
    onNone: () => status.startedAt,
    onSome: (at) => DateTime.formatLocal(at, { dateStyle: "short", timeStyle: "medium" }),
  });

  const flowLine = (flow: DaemonStatus["repos"][number]["flows"][number]) => {
    const name = `${flow.name}${asSuffix(Option.fromUndefinedOr(flow.persona))}`;

    if (!flow.enabled) {
      return `  ${name}: off${suffix(
        Option.filter(
          Option.fromUndefinedOr(flow.offReason),
          (reason) => reason !== FLOW_TURNED_OFF,
        ),
        ", ",
      )}`;
    }

    const elsewhere = flow.assignedElsewhere ?? [];

    return `  ${name}: ${flow.schedule}, next ${relative(flow.next, now)}${when(elsewhere.length > 0, `; assigned elsewhere: ${elsewhere.join(", ")}`)}`;
  };

  return [
    `daemon ${status.pid}, up since ${upSince}${when(status.reloadPending, ", restarting on new config when idle")}`,
    "",
    ...status.repos.flatMap((repo) => [
      `${repo.name} (${repo.slug}): ${repoLine(repo)}${suffix(repo.launcher, ", launcher ")}${suffix(repo.message, " — ")}`,
      ...repo.flows.map(flowLine),
    ]),
    "",
    Option.match(Arr.head(status.active), {
      onNone: () => "nothing in flight",
      onSome: () => "in flight:",
    }),
    ...status.active.map(
      (run) =>
        `  ${shortRunId(run.id)}  ${runLabel(run)}  ${runLine(run)}${suffix(run.itemTitle, "  ")}`,
    ),
    ...Option.toArray(Option.map(Arr.head(finished), () => "\nrecent:")),
    ...finished
      .slice(0, 8)
      .map(
        (run) =>
          `  ${run.status.padEnd(11)} ${shortRunId(run.id)}  ${runLabel(run)}  ${Option.getOrElse(run.summary, () => "")}`,
      ),
    ...Option.toArray(Option.map(Arr.head(status.skips), () => "\nrecent skips:")),
    ...status.skips.slice(0, 5).map(
      (skip) =>
        `  ${skip.repo}/${skip.flow}${suffix(
          Option.map(skip.persona, (login) => `@${login}`),
          "",
        )}${suffix(skip.itemKey, " ")}: ${skip.reason} (${relative(Option.some(skip.at), now)})`,
    ),
  ];
};

const trustLine = (tree: Result.Result<string, unknown>, trusted: Option.Option<string>) => {
  if (Result.isFailure(tree)) {
    return "no .chernabog/ on its base branch";
  }

  if (Option.contains(trusted, tree.success)) {
    return "trusted";
  }

  return "not trusted";
};

const statusHandler = Effect.gen(function* () {
  const live = yield* Effect.result(daemonStatus);

  if (Result.isSuccess(live)) {
    return yield* printLines(describeStatus(live.success, yield* DateTime.now));
  }

  yield* Console.log(live.failure.message);
  const machine = yield* loadMachineConfig;

  for (const repo of machine.repos) {
    const tree = yield* Effect.result(configTree(repo.path, repo.baseBranch ?? "main", false));
    yield* Console.log(
      `${repoNameOf(repo)} (${repo.repo}): ${trustLine(tree, (yield* findTrustedTreeUseCase(RepoSlug.make(repo.repo))).tree)}`,
    );
  }
});

const status = Command.make("status", {}, () => statusHandler).pipe(
  Command.withDescription(
    "What the daemon is doing: repos, schedules, runs in flight, recent runs and skips",
  ),
);

// A comma-separated list flag, such as --flows implement,review.
const listFlag = (name: string, description: string) =>
  Flag.String(name).pipe(
    Flag.withDescription(description),
    Flag.optional,
    Flag.map(
      Option.map((text) =>
        text
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      ),
    ),
  );

const setupFlags = {
  persona: listFlag(
    "persona",
    "The GitHub logins to act as, comma-separated, from gh auth status. Asked in a terminal when gh has several; the only one otherwise",
  ),
  account: listFlag(
    "account",
    "AI account directories to add, comma-separated, each dir or dir:agent, such as ~/.claude-personal. Found ones are asked about in a terminal",
  ),
};

const runSetup = (options: {
  readonly persona: Option.Option<ReadonlyArray<string>>;
  readonly account: Option.Option<ReadonlyArray<string>>;
}) => Effect.flatMap(setup({ personas: options.persona, accounts: options.account }), printLines);

const setupCommand = Command.make("setup", setupFlags, runSetup).pipe(
  Command.withDescription(
    "Choose the GitHub personas this machine acts as and the AI accounts its runs spend; safe to run again",
  ),
);

const installCommand = Command.make("install", setupFlags, (options) =>
  runSetup(options).pipe(Effect.andThen(Effect.flatMap(install, Console.log))),
).pipe(
  Command.withDescription(
    "Set up personas and accounts, then register the daemon with launchd (macOS) or systemd (Linux) and start it",
  ),
);

const uninstallCommand = Command.make("uninstall", {}, () =>
  Effect.flatMap(uninstall, Console.log),
).pipe(Command.withDescription("Stop the daemon and remove its service"));

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

      yield* Console.log(yield* startService);
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

const stop = Command.make("stop", {}, () => Effect.flatMap(stopService, Console.log)).pipe(
  Command.withDescription("Stop the daemon; runs in flight resume when it starts again"),
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

const isRunning = (row: Option.Option<RunView>) =>
  Option.exists(row, (found) => found.status === "running");

// Prints a run's log as it grows, until the run finishes.
const followRun = (runId: string) =>
  Effect.gen(function* () {
    const tail = tailer(yield* runLogFile(runId));
    const poll = tail.pipe(Effect.andThen(daemonRunRow(runId)));

    const row = yield* poll.pipe(
      Effect.repeat({ schedule: Schedule.spaced("2 seconds"), while: isRunning }),
    );

    yield* tail;

    return row;
  });

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

    yield* reportFinished(yield* followRun(runId.value));
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

const logs = Command.make(
  "logs",
  {
    run: Argument.String("run"),
    follow: Flag.Boolean("follow").pipe(Flag.withAlias("f"), Flag.withDefault(false)),
  },
  ({ follow, run: named }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runId = yield* resolveRunId(named);
      const path = yield* runLogFile(runId);

      if (!(yield* fs.exists(path))) {
        return yield* fail(`no log for ${runId} at ${path}`);
      }

      if (follow) {
        return yield* followRun(runId).pipe(Effect.asVoid);
      }

      yield* Console.log((yield* fs.readFileString(path)).trimEnd());
    }),
).pipe(Command.withDescription("Print a run's log"));

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

// The repo a path is in; the working directory's when none is given.
const rootOf = (path: Option.Option<string>) => repoRoot(Option.getOrElse(path, () => "."));

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
    const slug = yield* Effect.option(slugOf(root));
    let declined = false;

    if (Option.isNone(slug)) {
      return declined;
    }

    for (const entry of yield* movedEntries(yield* loadMachineConfig, slug.value, root)) {
      const named = repoNameOf(entry);

      if (
        !(yield* confirmed(
          `${named} (${entry.repo}) is enrolled at ${entry.path}, which is gone. Point it here, keeping its settings?`,
        ))
      ) {
        yield* Console.log(
          `${named} is enrolled at ${entry.path}, which is gone; chernabog enroll${suffix(Option.fromUndefinedOr(entry.name), " --name ")} here points it here, keeping its settings`,
        );
        declined = true;
        continue;
      }

      yield* repoint(entry, root);
      yield* Console.log(`pointed ${named} at ${root}`);
      yield* daemonReload.pipe(Effect.ignore);
    }

    return declined;
  });

const enrollFlags = {
  account: listFlag(
    "account",
    "Accounts from machine config to spend, comma-separated: the persona's own, and one for each other agent its flows need. Asked in a terminal where there's a choice",
  ),
  name: Flag.String("name").pipe(
    Flag.withDescription("A short name, when two enrolled repos share one"),
    Flag.optional,
  ),
  persona: listFlag(
    "persona",
    "The GitHub personas that work in this repo, comma-separated. Asked in a terminal when machine config has several",
  ),
  flows: listFlag(
    "flows",
    "The flows to run, comma-separated, for every chosen persona. Asked in a terminal for each persona",
  ),
  defaults: Flag.Boolean("defaults").pipe(
    Flag.withDescription("Run the team's default flows for every chosen persona, without asking"),
    Flag.withDefault(false),
  ),
};

type EnrollFlags = {
  readonly account: Option.Option<ReadonlyArray<string>>;
  readonly name: Option.Option<string>;
  readonly persona: Option.Option<ReadonlyArray<string>>;
  readonly flows: Option.Option<ReadonlyArray<string>>;
  readonly defaults: boolean;
};

// Enrolls the repo at `root` and says what it chose. A running daemon restarts to schedule it; none running is fine.
const enrollHere = (root: string, flags: EnrollFlags) =>
  Effect.gen(function* () {
    const { action, lines, repo } = yield* enrollRepo(root, {
      account: flags.account,
      name: flags.name,
      personas: flags.persona,
      flows: flags.flows,
      defaults: flags.defaults,
    });

    yield* Console.log(
      `${action} ${repo.repo} (${repo.path}, base ${repo.baseBranch ?? "main"}) in ${yield* machineConfigFile}`,
    );
    yield* printLines(lines);
    yield* daemonReload.pipe(Effect.ignore);

    return repo;
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
      if ((yield* flowNames(`${root}/.chernabog`)).length === 0) {
        yield* Console.log(
          `Not enrolled: .chernabog/flows/ has no flows. Add recipes with chernabog recipes add (${RECIPES_LIST}), or write a flow, then chernabog enroll here.`,
        );

        return;
      }

      const repo = yield* enrollHere(root, flags);
      yield* Console.log(
        `Next: commit .chernabog/ if it's new and merge it to the base branch, then chernabog trust ${repoNameOf(repo)}.`,
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

const enrollCommand = Command.make(
  "enroll",
  { path: Argument.String("path").pipe(Argument.optional), ...enrollFlags },
  ({ path, ...flags }) =>
    Effect.gen(function* () {
      const repo = yield* enrollHere(yield* rootOf(path), flags);
      yield* Console.log(`Next: chernabog trust ${repoNameOf(repo)}`);
    }),
).pipe(
  Command.withDescription(
    "Add a repo to this machine's config: which personas work in it, which flows each runs, and which accounts they spend",
  ),
);

const unenroll = Command.make("unenroll", { repo: repoArgument }, ({ repo }) =>
  Effect.gen(function* () {
    const removed = yield* unenrollFromMachineConfig(repo);
    yield* Console.log(
      `removed ${repoNameOf(removed)} (${removed.repo}, ${removed.path}) and its settings from ${yield* machineConfigFile}`,
    );
    yield* daemonReload.pipe(Effect.ignore);
  }),
).pipe(Command.withDescription("Remove a repo, and its settings, from this machine's config"));

const attach = Command.make("attach", { run: Argument.String("run") }, ({ run: named }) =>
  Effect.gen(function* () {
    const runId = yield* resolveRunId(named);
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

  return yield* statusHandler;
});

export const chernabog = Command.make("chernabog", {}, () => live).pipe(
  Command.withDescription("Spends spare coding-agent capacity on queued work across your repos"),
  Command.withSubcommands([
    status,
    attach,
    run,
    trigger,
    openPrCommand,
    logs,
    pauseCommand,
    resumeCommand,
    trustCommand,
    labels,
    doctorCommand,
    setupCommand,
    init,
    recipesCommand,
    enrollCommand,
    unenroll,
    installCommand,
    uninstallCommand,
    start,
    stop,
    daemon,
    Command.unlisted(stepChild),
    Command.unlisted(launchChild),
    Command.unlisted(stopHookChild),
  ]),
);

const PlatformLive = Layer.mergeAll(BunServices.layer, HostEnvironment.layer, Home.layer);

// One GitHubTokens for the process, so each persona's token is looked up once.
const AppLive = Layer.mergeAll(
  GitHubApi.layerFor(IMPLICIT),
  Asker.layer,
  EnrollmentLayer,
  TrustLayer,
).pipe(
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
