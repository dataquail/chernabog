import { Command } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { CheckRunLeasesCommand } from "./commands/check-run-leases.command.ts";
import { checkRunLeasesHandler } from "./commands/check-run-leases.handler.ts";
import { EnterStepCommand } from "./commands/enter-step.command.ts";
import { enterStepHandler } from "./commands/enter-step.handler.ts";
import { FinishRunCommand } from "./commands/finish-run.command.ts";
import { finishRunHandler } from "./commands/finish-run.handler.ts";
import { ParkRunCommand } from "./commands/park-run.command.ts";
import { parkRunHandler } from "./commands/park-run.handler.ts";
import { PlanTickCommand } from "./commands/plan-tick.command.ts";
import { planTickHandler } from "./commands/plan-tick.handler.ts";
import { StartFlowRunCommand } from "./commands/start-flow-run.command.ts";
import { startFlowRunHandler } from "./commands/start-flow-run.handler.ts";
import { StartRunCommand } from "./commands/start-run.command.ts";
import { startRunHandler } from "./commands/start-run.handler.ts";

// What changes the runs' stores in state.db alone. Those stores share the SQL
// client the workflow engine journals to, so the handlers take them from the
// composition root that holds state.db, as the runs' queries do.
export const runsCommandGroup = Command.group(
  EnterStepCommand,
  FinishRunCommand,
  ParkRunCommand,
  StartRunCommand,
);

const RunsCommandHandlersLive = Command.handlersOf(runsCommandGroup, {
  EnterStepCommand: (payload) => enterStepHandler(payload),
  FinishRunCommand: (payload) => finishRunHandler(payload),
  ParkRunCommand: (payload) => parkRunHandler(payload),
  StartRunCommand: (payload) => startRunHandler(payload),
});

// The runs module's slice of the write side over state.db, which the engine
// dispatches as a run takes its steps and parks on a signal.
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
  CheckRunLeasesCommand,
  PlanTickCommand,
  StartFlowRunCommand,
);

const RunFlowsCommandHandlersLive = Command.handlersOf(runFlowsCommandGroup, {
  CheckRunLeasesCommand: (payload) => checkRunLeasesHandler(payload),
  PlanTickCommand: (payload) => planTickHandler(payload),
  StartFlowRunCommand: (payload) => startFlowRunHandler(payload),
});

// The runs module's slice of the write side over the loaded flows, which the
// daemon dispatches to check and renew its runs' leases, to plan each tick of
// a flow and to start its runs, and `run` and `rehearse` to start one.
export class RunFlowsCommands extends Context.Service<
  RunFlowsCommands,
  Command.Dispatcher<typeof runFlowsCommandGroup>
>()("RunFlowsCommands") {}

export const RunFlowsCommandsLive = Layer.effect(
  RunFlowsCommands,
  Command.dispatcher(runFlowsCommandGroup),
).pipe(Layer.provideMerge(RunFlowsCommandHandlersLive));
