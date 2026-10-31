import { Command, makeEventBus } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { AdoptImplicitRunsCommand } from "./commands/adopt-implicit-runs.command.ts";
import { adoptImplicitRunsHandler } from "./commands/adopt-implicit-runs.handler.ts";
import { AttachExecutionCommand } from "./commands/attach-execution.command.ts";
import { attachExecutionHandler } from "./commands/attach-execution.handler.ts";
import { CancelRunCommand } from "./commands/cancel-run.command.ts";
import { cancelRunHandler } from "./commands/cancel-run.handler.ts";
import { CheckRunLeasesCommand } from "./commands/check-run-leases.command.ts";
import { checkRunLeasesHandler } from "./commands/check-run-leases.handler.ts";
import { DeliverSignalsCommand } from "./commands/deliver-signals.command.ts";
import { deliverSignalsHandler } from "./commands/deliver-signals.handler.ts";
import { EnterStepCommand } from "./commands/enter-step.command.ts";
import { enterStepHandler } from "./commands/enter-step.handler.ts";
import { FinishRunCommand } from "./commands/finish-run.command.ts";
import { finishRunHandler } from "./commands/finish-run.handler.ts";
import { ForgetMarkerCommand } from "./commands/forget-marker.command.ts";
import { forgetMarkerHandler } from "./commands/forget-marker.handler.ts";
import { GateFlowCommand } from "./commands/gate-flow.command.ts";
import { gateFlowHandler } from "./commands/gate-flow.handler.ts";
import { HoldMarkerCommand } from "./commands/hold-marker.command.ts";
import { holdMarkerHandler } from "./commands/hold-marker.handler.ts";
import { NameSubjectCommand } from "./commands/name-subject.command.ts";
import { nameSubjectHandler } from "./commands/name-subject.handler.ts";
import { ParkRunCommand } from "./commands/park-run.command.ts";
import { parkRunHandler } from "./commands/park-run.handler.ts";
import { PlanTickCommand } from "./commands/plan-tick.command.ts";
import { planTickHandler } from "./commands/plan-tick.handler.ts";
import { PollRunCommand } from "./commands/poll-run.command.ts";
import { pollRunHandler } from "./commands/poll-run.handler.ts";
import { RecordSkipCommand } from "./commands/record-skip.command.ts";
import { recordSkipHandler } from "./commands/record-skip.handler.ts";
import { RecoverRunsCommand } from "./commands/recover-runs.command.ts";
import { recoverRunsHandler } from "./commands/recover-runs.handler.ts";
import { ReleaseMarkersCommand } from "./commands/release-markers.command.ts";
import { releaseMarkersHandler } from "./commands/release-markers.handler.ts";
import { ReleaseRunWaitCommand } from "./commands/release-run-wait.command.ts";
import { releaseRunWaitHandler } from "./commands/release-run-wait.handler.ts";
import { ResumeRunCommand } from "./commands/resume-run.command.ts";
import { resumeRunHandler } from "./commands/resume-run.handler.ts";
import { StartFlowRunCommand } from "./commands/start-flow-run.command.ts";
import { startFlowRunHandler } from "./commands/start-flow-run.handler.ts";
import { StartRunCommand } from "./commands/start-run.command.ts";
import { startRunHandler } from "./commands/start-run.handler.ts";

// Where the runs' commands say what happened to a run (RunStarted,
// RunEnteredStep, RunNeedsAttention, RunFinished, PullRequestOpened), for the
// dashboard's /events stream and the notifier to hear. One per process, beside
// the state.db its commands write.
export const RunEventsLive = makeEventBus();

// What changes the runs' stores in state.db alone. Those stores share the SQL
// client the workflow engine journals to, so the handlers take them from the
// composition root that holds state.db, as the runs' queries do.
export const runsCommandGroup = Command.group(
  AdoptImplicitRunsCommand,
  AttachExecutionCommand,
  EnterStepCommand,
  FinishRunCommand,
  ForgetMarkerCommand,
  HoldMarkerCommand,
  NameSubjectCommand,
  ParkRunCommand,
  RecordSkipCommand,
  ReleaseRunWaitCommand,
  StartRunCommand,
);

const RunsCommandHandlersLive = Command.handlersOf(runsCommandGroup, {
  AdoptImplicitRunsCommand: (payload) => adoptImplicitRunsHandler(payload),
  AttachExecutionCommand: (payload) => attachExecutionHandler(payload),
  EnterStepCommand: (payload) => enterStepHandler(payload),
  FinishRunCommand: (payload) => finishRunHandler(payload),
  ForgetMarkerCommand: (payload) => forgetMarkerHandler(payload),
  HoldMarkerCommand: (payload) => holdMarkerHandler(payload),
  NameSubjectCommand: (payload) => nameSubjectHandler(payload),
  ParkRunCommand: (payload) => parkRunHandler(payload),
  RecordSkipCommand: (payload) => recordSkipHandler(payload),
  ReleaseRunWaitCommand: (payload) => releaseRunWaitHandler(payload),
  StartRunCommand: (payload) => startRunHandler(payload),
});

// The runs module's slice of the write side over state.db, which the engine
// dispatches as a run takes its steps, parks on a signal, holds and forgets
// its markers and names its subjects, and the daemon and `run` to adopt a
// repo's runs from before its personas and to forget a wait its signal woke,
// and the daemon to record why a tick started nothing.
export class RunsCommands extends Context.Service<
  RunsCommands,
  Command.Dispatcher<typeof runsCommandGroup>
>()("RunsCommands") {}

export const RunsCommandsLive = Layer.effect(
  RunsCommands,
  Command.dispatcher(runsCommandGroup),
).pipe(Layer.provideMerge(RunsCommandHandlersLive));

// What changes the runs through the flows a process loaded and their
// workflows in its engine, over the stores in state.db. The flows are built
// inside the engine, over those stores, so this group is provided over a
// process's runtime (the daemon, a foreground run, a rehearsal), apart from
// the commands the engine itself dispatches.
export const runFlowsCommandGroup = Command.group(
  CancelRunCommand,
  CheckRunLeasesCommand,
  DeliverSignalsCommand,
  GateFlowCommand,
  PlanTickCommand,
  PollRunCommand,
  RecoverRunsCommand,
  ReleaseMarkersCommand,
  ResumeRunCommand,
  StartFlowRunCommand,
);

const RunFlowsCommandHandlersLive = Command.handlersOf(runFlowsCommandGroup, {
  CancelRunCommand: (payload) => cancelRunHandler(payload),
  CheckRunLeasesCommand: (payload) => checkRunLeasesHandler(payload),
  DeliverSignalsCommand: (payload) => deliverSignalsHandler(payload),
  GateFlowCommand: (payload) => gateFlowHandler(payload),
  PlanTickCommand: (payload) => planTickHandler(payload),
  PollRunCommand: (payload) => pollRunHandler(payload),
  RecoverRunsCommand: () => recoverRunsHandler(),
  ReleaseMarkersCommand: () => releaseMarkersHandler(),
  ResumeRunCommand: (payload) => resumeRunHandler(payload),
  StartFlowRunCommand: (payload) => startFlowRunHandler(payload),
});

// The runs module's slice of the write side over the loaded flows, which the
// daemon dispatches to check and renew its runs' leases, to plan each tick of
// a flow, to deliver its signals, to ask its gate, to start its runs, to poll
// them until they end, to recover the starts a crash interrupted, to release
// the markers ended runs hold and to end a run, `run` and `rehearse` to start
// one, deliver its signals and poll it (and `run` to recover and resume one
// and release what it held), and `cancel` to end one with the daemon stopped.
export class RunFlowsCommands extends Context.Service<
  RunFlowsCommands,
  Command.Dispatcher<typeof runFlowsCommandGroup>
>()("RunFlowsCommands") {}

export const RunFlowsCommandsLive = Layer.effect(
  RunFlowsCommands,
  Command.dispatcher(runFlowsCommandGroup),
).pipe(Layer.provideMerge(RunFlowsCommandHandlersLive));
