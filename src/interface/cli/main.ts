#!/usr/bin/env bun
// The chernabog command line.

import { describeError } from "@chernabog/core";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { makeEventBus } from "@effect-server-utils/cqrs";
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
import * as Stream from "effect/Stream";

import { IMPLICIT } from "../../kernel/persona.value-object.ts";
import { RunId } from "../../kernel/run-id.id.ts";
import { migrateMachineConfig } from "../../migrate.ts";
import { MachineCommands } from "../../modules/machine/machine.platform.ts";
import {
  type ActiveRun,
  attachCommand,
  declaredLabels,
  questionHook,
  repoConfigDir,
  runLaunch,
  RunLogsQueries,
  runSessions,
  runStepChild,
  type RunView,
  StepServicesLive,
  stopHook,
  syncLabels,
} from "../../modules/runs/runs.platform.ts";
import { HostEnvironment } from "../../platform/environment.ts";
import { Exec } from "../../platform/exec.ts";
import { loadFlows } from "../../platform/flow-loader.ts";
import { GitHubApi } from "../../platform/github-api.ts";
import { GitHubTokens } from "../../platform/github-auth.ts";
import { Home, homePaths } from "../../platform/home.ts";
import { withShutdownDeadline } from "../../platform/shutdown.ts";
import { VERSION } from "../../platform/version.ts";
import { checkFlowSettings, findEnrolled, loadMachineConfig, loadRepo } from "../../repo-config.ts";
import { applicationModules } from "../application-modules.ts";
import { daemonRun, daemonTick } from "../daemon/daemon.client.ts";
import type { TickResult } from "../daemon/daemon.protocol.ts";
import { RELOAD_EXIT_CODE, runDaemon } from "../daemon/daemon.server.ts";
import { runTui } from "../tui/app.ts";
import { Asker } from "./asker.prompt.ts";
import { showStatus, statusCommand } from "./daemon/status.command.ts";
import { enrollCommand } from "./enrollment/enroll.command.ts";
import { pauseCommand } from "./enrollment/pause.command.ts";
import { resumeCommand } from "./enrollment/resume.command.ts";
import { unenrollCommand } from "./enrollment/unenroll.command.ts";
import { doctorCommand } from "./machine/doctor.main.ts";
import { installCommand, stopCommand, uninstallCommand } from "./machine/service.command.ts";
import { setupCommand } from "./machine/setup.command.ts";
import { initCommand } from "./recipes/init.command.ts";
import { recipesCommand } from "./recipes/recipes.command.ts";
import { rehearseCommand } from "./rehearsals/rehearse.main.ts";
import { optionalRepo, repoFlag } from "./repo.arguments.ts";
import { cancelRun } from "./runs/cancel.main.ts";
import { logsCommand } from "./runs/logs.command.ts";
import { openPr } from "./runs/open-pr.main.ts";
import { runInForeground } from "./runs/run.main.ts";
import { followRunLog } from "./runs/run-log.output.ts";
import { openSession, startIssue } from "./runs/start.main.ts";
import { trustCommand } from "./trust/trust.command.ts";

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

      yield* (yield* MachineCommands).StartServiceCommand();
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
    draft: Flag.Boolean("draft").pipe(
      Flag.withDescription(
        "Keep it as a draft and print the question that asks the person whether to open it; their Yes hands it over",
      ),
      Flag.withDefault(false),
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

    yield* Console.log(
      `started ${runId.value}, log: ${homePaths((yield* Home).root).runLog(runId.value)}`,
    );

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

const cancel = Command.make(
  "cancel",
  {
    run: Argument.String("run").pipe(
      Argument.withDescription("The run's id, or enough of it; with an item, the repo it's in"),
    ),
    item: Argument.String("item").pipe(
      Argument.withDescription("The work item a run is in flight for, such as pr-116 or issue-12"),
      Argument.optional,
    ),
    flow: Flag.String("flow").pipe(
      Flag.withDescription("The flow, when several runs are in flight for the item"),
      Flag.optional,
    ),
    as: Flag.String("as").pipe(
      Flag.withDescription("The persona, when several runs are in flight for the item"),
      Flag.optional,
    ),
    closeSession: Flag.Boolean("close-session").pipe(
      Flag.withDescription(
        "Also close the agent sessions the run left open, through their launcher; otherwise they're left to you",
      ),
      Flag.withDefault(false),
    ),
  },
  ({ as, closeSession, flow, item, run: named }) =>
    cancelRun({ run: named, item, flow, persona: as, closeSessions: closeSession }).pipe(
      Effect.flatMap(printLines),
      Effect.catchTags({
        DaemonRefused: (refused) => fail(refused.message),
        RunNotNamed: (failure) => fail(failure.message),
        RunNotFound: (failure) => fail(failure.message),
        AmbiguousRunPrefix: (failure) => fail(failure.message),
        RunAlreadyFinished: (failure) => fail(failure.message),
        NoRunInFlight: (failure) => fail(failure.message),
        SeveralRunsInFlight: (failure) => fail(failure.message),
      }),
    ),
).pipe(
  Command.withDescription(
    "End a run in flight for good: it stops, is recorded as cancelled, and its worktrees and claim are released; through the daemon when it is running",
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
        const effective = yield* loadRepo(machine, enrolled, configDir);
        const flows = yield* loadFlows(configDir);
        yield* checkFlowSettings(effective, flows);
        yield* Console.log(
          yield* syncLabels(enrolled.repo, yield* declaredLabels(effective, flows)),
        );
      }
    }),
).pipe(Command.withDescription("Create or correct the labels each repo's flows declare"));

const attach = Command.make("attach", { run: Argument.String("run") }, ({ run: named }) =>
  Effect.gen(function* () {
    const { runId } = yield* (yield* RunLogsQueries).ResolveRunIdQuery({ asked: named });
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

// Claude's PreToolUse and PostToolUse hook on AskUserQuestion, in a session with a person.
const questionHookChild = Command.make("__question-hook", { dir: Flag.String("dir") }, ({ dir }) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const input = yield* Stream.mkString(Stream.decodeText(stdio.stdin));
    const printed = yield* questionHook(dir, input);
    yield* Option.match(printed, { onNone: () => Effect.void, onSome: Console.log });
  }),
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
    rehearseCommand,
    cancel,
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
    Command.unlisted(questionHookChild),
  ]),
);

const PlatformLive = Layer.mergeAll(BunServices.layer, HostEnvironment.layer, Home.layer);

// Every module, over the CLI's own services: one GitHubTokens for the process,
// so each persona's token is looked up once, and one bus that the modules'
// commands dispatch their events on.
const AppLive = applicationModules.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(GitHubApi.layerFor(IMPLICIT), Asker.layer, makeEventBus())),
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
    // Stopping is bookkeeping; whatever it cuts short resumes at the next start.
    withShutdownDeadline("3 seconds"),
    BunRuntime.runMain({ disableErrorReporting: true }),
  );
}
