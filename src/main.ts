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
import { Asker } from "./interface/cli/asker.prompt.ts";
import { showStatus, statusCommand } from "./interface/cli/daemon/status.command.ts";
import { enrollCommand } from "./interface/cli/enrollment/enroll.command.ts";
import { pauseCommand } from "./interface/cli/enrollment/pause.command.ts";
import { resumeCommand } from "./interface/cli/enrollment/resume.command.ts";
import { unenrollCommand } from "./interface/cli/enrollment/unenroll.command.ts";
import {
  installCommand,
  stopCommand,
  uninstallCommand,
} from "./interface/cli/machine/service.command.ts";
import { setupCommand } from "./interface/cli/machine/setup.command.ts";
import { initCommand } from "./interface/cli/recipes/init.command.ts";
import { recipesCommand } from "./interface/cli/recipes/recipes.command.ts";
import { optionalRepo, repoFlag } from "./interface/cli/repo.arguments.ts";
import { logsCommand } from "./interface/cli/runs/logs.command.ts";
import { followRunLog } from "./interface/cli/runs/run-log.output.ts";
import { trustCommand } from "./interface/cli/trust/trust.command.ts";
import { daemonRun, daemonTick } from "./interface/daemon/daemon.client.ts";
import type { TickResult } from "./interface/daemon/daemon.protocol.ts";
import { IMPLICIT } from "./kernel/persona.value-object.ts";
import { RunId } from "./kernel/run-id.id.ts";
import { desiredLabels, syncLabels, withFlowLabels } from "./labels.ts";
import { runLaunch } from "./launchers/shim.ts";
import { loadFlows } from "./loader.ts";
import { migrateMachineConfig } from "./migrate.ts";
import { EnrollmentLayer } from "./modules/enrollment/enrollment.layer.ts";
import { MachineLayer } from "./modules/machine/machine.layer.ts";
import { startServiceUseCase } from "./modules/machine/use-cases/start-service.use-case.ts";
import { RecipesLayer } from "./modules/recipes/recipes.layer.ts";
import { RunLogsLayer } from "./modules/runs/runs.layer.ts";
import { resolveRunIdUseCase } from "./modules/runs/use-cases/resolve-run-id.use-case.ts";
import { type ActiveRun, type RunView } from "./modules/runs/use-cases/run.result.ts";
import { TrustLayer } from "./modules/trust/trust.layer.ts";
import { openPr } from "./open-pr.ts";
import { HostEnvironment } from "./platform/environment.ts";
import { Exec } from "./platform/exec.ts";
import { GitHubApi } from "./platform/github-api.ts";
import { GitHubTokens } from "./platform/github-auth.ts";
import { VERSION } from "./platform/version.ts";
import { findEnrolled, loadMachineConfig, loadRepo } from "./repo-config.ts";
import { repoConfigDir, runInForeground } from "./runner.ts";
import { openSession, startIssue } from "./start.ts";
import { runStepChild, StepServicesLive } from "./steps.ts";
import { runTui } from "./tui/app.ts";

const printLines = (lines: Iterable<string>) =>
  Effect.forEach(lines, (line) => Console.log(line), { discard: true });

const fail = (message: string) =>
  Effect.gen(function* () {
    yield* Console.error(message);
    process.exitCode = 1;
  });

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
    initCommand,
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
const AppLive = Layer.mergeAll(
  EnrollmentLayer,
  TrustLayer,
  RunLogsLayer,
  MachineLayer,
  RecipesLayer,
).pipe(
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
