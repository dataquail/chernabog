import { Command } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ownUnitOfWork } from "../../platform/unit-of-work.ts";
import { AdoptImplicitRunsCommand } from "./commands/adopt-implicit-runs.command.ts";
import { adoptImplicitRunsHandler } from "./commands/adopt-implicit-runs.handler.ts";
import { AdvanceSpokeFoldCommand } from "./commands/advance-spoke-fold.command.ts";
import { advanceSpokeFoldHandler } from "./commands/advance-spoke-fold.handler.ts";
import { AttachExecutionCommand } from "./commands/attach-execution.command.ts";
import { attachExecutionHandler } from "./commands/attach-execution.handler.ts";
import { CancelRunCommand } from "./commands/cancel-run.command.ts";
import { cancelRunHandler } from "./commands/cancel-run.handler.ts";
import { CheckRunLeasesCommand } from "./commands/check-run-leases.command.ts";
import { checkRunLeasesHandler } from "./commands/check-run-leases.handler.ts";
import { DeclareLaneCommand } from "./commands/declare-lane.command.ts";
import { declareLaneHandler } from "./commands/declare-lane.handler.ts";
import { EnterStepCommand } from "./commands/enter-step.command.ts";
import { enterStepHandler } from "./commands/enter-step.handler.ts";
import { ExecuteRunCommand } from "./commands/execute-run.command.ts";
import { executeRunHandler } from "./commands/execute-run.handler.ts";
import { FinishRunCommand } from "./commands/finish-run.command.ts";
import { finishRunHandler } from "./commands/finish-run.handler.ts";
import { FinishStepCommand } from "./commands/finish-step.command.ts";
import { finishStepHandler } from "./commands/finish-step.handler.ts";
import { ForgetMarkerCommand } from "./commands/forget-marker.command.ts";
import { forgetMarkerHandler } from "./commands/forget-marker.handler.ts";
import { ForgetSpokeCommand } from "./commands/forget-spoke.command.ts";
import { forgetSpokeHandler } from "./commands/forget-spoke.handler.ts";
import { GateFlowCommand } from "./commands/gate-flow.command.ts";
import { gateFlowHandler } from "./commands/gate-flow.handler.ts";
import { HoldMarkerCommand } from "./commands/hold-marker.command.ts";
import { holdMarkerHandler } from "./commands/hold-marker.handler.ts";
import { IntendSpokeEndingCommand } from "./commands/intend-spoke-ending.command.ts";
import { intendSpokeEndingHandler } from "./commands/intend-spoke-ending.handler.ts";
import { NameSubjectCommand } from "./commands/name-subject.command.ts";
import { nameSubjectHandler } from "./commands/name-subject.handler.ts";
import { ParkRunCommand } from "./commands/park-run.command.ts";
import { parkRunHandler } from "./commands/park-run.handler.ts";
import { PlanTickCommand } from "./commands/plan-tick.command.ts";
import { planTickHandler } from "./commands/plan-tick.handler.ts";
import { PruneRunLogsCommand } from "./commands/prune-run-logs.command.ts";
import { pruneRunLogsHandler } from "./commands/prune-run-logs.handler.ts";
import { RecordCreatedIssueCommand } from "./commands/record-created-issue.command.ts";
import { recordCreatedIssueHandler } from "./commands/record-created-issue.handler.ts";
import { RecordNodeCommand } from "./commands/record-node.command.ts";
import { recordNodeHandler } from "./commands/record-node.handler.ts";
import { RecordSkipCommand } from "./commands/record-skip.command.ts";
import { recordSkipHandler } from "./commands/record-skip.handler.ts";
import { RecordSpokeCommand } from "./commands/record-spoke.command.ts";
import { recordSpokeHandler } from "./commands/record-spoke.handler.ts";
import { RecordTokenUsageCommand } from "./commands/record-token-usage.command.ts";
import { recordTokenUsageHandler } from "./commands/record-token-usage.handler.ts";
import { ReleaseMarkersCommand } from "./commands/release-markers.command.ts";
import { releaseMarkersHandler } from "./commands/release-markers.handler.ts";
import { ReleaseRunWaitCommand } from "./commands/release-run-wait.command.ts";
import { releaseRunWaitHandler } from "./commands/release-run-wait.handler.ts";
import { ReportRunEndedCommand } from "./commands/report-run-ended.command.ts";
import { reportRunEndedHandler } from "./commands/report-run-ended.handler.ts";
import { SaveRunPlanCommand } from "./commands/save-run-plan.command.ts";
import { saveRunPlanHandler } from "./commands/save-run-plan.handler.ts";
import { StartRunCommand } from "./commands/start-run.command.ts";
import { startRunHandler } from "./commands/start-run.handler.ts";
import { StartSpokeRunCommand } from "./commands/start-spoke-run.command.ts";
import { startSpokeRunHandler } from "./commands/start-spoke-run.handler.ts";
import { SweepContainersCommand } from "./commands/sweep-containers.command.ts";
import { sweepContainersHandler } from "./commands/sweep-containers.handler.ts";
import { SweepJournalsCommand } from "./commands/sweep-journals.command.ts";
import { sweepJournalsHandler } from "./commands/sweep-journals.handler.ts";
import {
  runFlowsCommandSpanAttributes,
  runsCommandSpanAttributes,
} from "./runs.event-span-attributes.ts";

// What changes the runs' stores in state.db alone. Those stores share the SQL
// client the workflow engine journals to, which the composition root that holds
// state.db provides, as it does for the runs' queries. The commands say what
// happened to a run (RunStarted, RunEnteredStep, RunFinishedStep,
// RunNeedsAttention, RunFinished, PullRequestOpened, TokenUsageRecorded, and
// where in its plan a run went: RunEnteredNode, RunFinishedNode,
// RunTookBranch, RunReachedEnd) on the EventBus the root provides.
export const runsCommandGroup = Command.group(
  AdoptImplicitRunsCommand,
  AdvanceSpokeFoldCommand,
  AttachExecutionCommand,
  DeclareLaneCommand,
  EnterStepCommand,
  FinishRunCommand,
  FinishStepCommand,
  ForgetMarkerCommand,
  ForgetSpokeCommand,
  HoldMarkerCommand,
  IntendSpokeEndingCommand,
  NameSubjectCommand,
  ParkRunCommand,
  PruneRunLogsCommand,
  RecordCreatedIssueCommand,
  RecordNodeCommand,
  RecordSkipCommand,
  RecordSpokeCommand,
  RecordTokenUsageCommand,
  ReleaseRunWaitCommand,
  SaveRunPlanCommand,
  StartRunCommand,
);

const RunsCommandHandlersLive = Command.handlersOf(runsCommandGroup, {
  AdoptImplicitRunsCommand: (payload) => adoptImplicitRunsHandler(payload),
  AdvanceSpokeFoldCommand: (payload) => advanceSpokeFoldHandler(payload),
  AttachExecutionCommand: (payload) => attachExecutionHandler(payload),
  DeclareLaneCommand: (payload) => declareLaneHandler(payload),
  EnterStepCommand: (payload) => enterStepHandler(payload),
  FinishRunCommand: (payload) => finishRunHandler(payload),
  FinishStepCommand: (payload) => finishStepHandler(payload),
  ForgetMarkerCommand: (payload) => forgetMarkerHandler(payload),
  ForgetSpokeCommand: (payload) => forgetSpokeHandler(payload),
  HoldMarkerCommand: (payload) => holdMarkerHandler(payload),
  IntendSpokeEndingCommand: (payload) => intendSpokeEndingHandler(payload),
  NameSubjectCommand: (payload) => nameSubjectHandler(payload),
  ParkRunCommand: (payload) => parkRunHandler(payload),
  PruneRunLogsCommand: () => pruneRunLogsHandler(),
  RecordCreatedIssueCommand: (payload) => recordCreatedIssueHandler(payload),
  RecordNodeCommand: (payload) => recordNodeHandler(payload),
  RecordSkipCommand: (payload) => recordSkipHandler(payload),
  RecordSpokeCommand: (payload) => recordSpokeHandler(payload),
  RecordTokenUsageCommand: (payload) => recordTokenUsageHandler(payload),
  ReleaseRunWaitCommand: (payload) => releaseRunWaitHandler(payload),
  SaveRunPlanCommand: (payload) => saveRunPlanHandler(payload),
  StartRunCommand: (payload) => startRunHandler(payload),
});

// The runs' commands a spoke reports in its journal rather than dispatching
// (ADR 23, decision 3): what its run records, each encoded with its own
// schema, which the hub folds into state.db by dispatching it on its bus.
export const SpokeReportCommand = {
  DeclareLaneCommand,
  EnterStepCommand,
  FinishStepCommand,
  ForgetMarkerCommand,
  HoldMarkerCommand,
  NameSubjectCommand,
  ParkRunCommand,
  RecordCreatedIssueCommand,
  RecordNodeCommand,
  RecordTokenUsageCommand,
  SaveRunPlanCommand,
} as const;

// The same, as a list: not a group, since each is in runsCommandGroup already.
export const spokeReportCommands = Object.values(SpokeReportCommand);

// A report's payload as its journal holds it, JSON, coded with its command's
// own payload schema: what the spoke writes and the hub reads back. A
// group keeps its messages' schemas erased, so it is rebuilt from the AST.
export const spokeReportPayloadJson = <M extends Command.Any>(command: M) =>
  Schema.fromJsonString(
    Schema.toCodecJson(
      Schema.make<Schema.Codec<Command.Payload<M>, unknown>>(command.schemas.payload.ast),
    ),
  );

// A report's payload, encoded as its journal holds it.
export const encodeSpokeReport = <M extends Command.Any>(command: M, payload: Command.Payload<M>) =>
  Schema.encodeSync(spokeReportPayloadJson(command))(payload);

// A report's payload decoded as `command`'s, or none for one that isn't.
export const decodeSpokeReport = <M extends Command.Any>(
  command: M,
  report: { readonly tag: string; readonly payload: string },
) =>
  Option.flatMap(
    Option.liftPredicate(report, (one) => one.tag === command.tag),
    (one) => Schema.decodeOption(spokeReportPayloadJson(command))(one.payload),
  );

// The runs module's slice of the write side over state.db, which the engine
// dispatches as a run takes its steps, parks on a signal, holds and forgets
// its markers, names its subjects and records the issues it created, and the daemon and `run` to adopt a
// repo's runs from before its personas and to forget a wait its signal woke,
// and the daemon to record why a tick started nothing and to prune the run
// logs past their retention, once a day.
export class RunsCommands extends Context.Service<
  RunsCommands,
  Command.Dispatcher<typeof runsCommandGroup>
>()("RunsCommands") {}

export const RunsCommandsLive = Layer.effect(
  RunsCommands,
  Effect.flatMap(ownUnitOfWork, (own) =>
    Command.dispatcher(runsCommandGroup, {
      middleware: [own],
      spanAttributes: runsCommandSpanAttributes,
    }),
  ),
).pipe(Layer.provideMerge(RunsCommandHandlersLive));

// What changes the runs through the flows a process loaded and their
// workflows in its engine, over the stores in state.db. The flows are built
// inside the engine, over those stores, so this group is provided over a
// process's runtime (the daemon, a foreground run, a rehearsal), apart from
// the commands the engine itself dispatches.
export const runFlowsCommandGroup = Command.group(
  CancelRunCommand,
  CheckRunLeasesCommand,
  ExecuteRunCommand,
  GateFlowCommand,
  PlanTickCommand,
  ReleaseMarkersCommand,
  ReportRunEndedCommand,
  StartSpokeRunCommand,
  SweepContainersCommand,
  SweepJournalsCommand,
);

const RunFlowsCommandHandlersLive = Command.handlersOf(runFlowsCommandGroup, {
  CancelRunCommand: (payload) => cancelRunHandler(payload),
  CheckRunLeasesCommand: (payload) => checkRunLeasesHandler(payload),
  ExecuteRunCommand: (payload) => executeRunHandler(payload),
  GateFlowCommand: (payload) => gateFlowHandler(payload),
  PlanTickCommand: (payload) => planTickHandler(payload),
  ReleaseMarkersCommand: () => releaseMarkersHandler(),
  ReportRunEndedCommand: (payload) => reportRunEndedHandler(payload),
  StartSpokeRunCommand: (payload) => startSpokeRunHandler(payload),
  SweepContainersCommand: () => sweepContainersHandler(),
  SweepJournalsCommand: () => sweepJournalsHandler(),
});

// The runs module's slice of the write side over the loaded flows, which the
// daemon dispatches to check and renew its runs' leases, to plan each tick of
// a flow, to ask its gate, to record the runs its spokes execute, to sweep
// the journals and containers of ended runs, to release the markers ended runs hold and to
// end a run; a spoke to execute the run it was handed and report how it
// ended; the foreground `run`, `rehearse` and `ci run` under Actions, each its
// own hub, to record a run, execute it and end it; and `cancel` to end one
// with the daemon stopped.
export class RunFlowsCommands extends Context.Service<
  RunFlowsCommands,
  Command.Dispatcher<typeof runFlowsCommandGroup>
>()("RunFlowsCommands") {}

export const RunFlowsCommandsLive = Layer.effect(
  RunFlowsCommands,
  Effect.flatMap(ownUnitOfWork, (own) =>
    Command.dispatcher(runFlowsCommandGroup, {
      middleware: [own],
      spanAttributes: runFlowsCommandSpanAttributes,
    }),
  ),
).pipe(Layer.provideMerge(RunFlowsCommandHandlersLive));
