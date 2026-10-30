import { Command } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { CheckRunLeasesCommand } from "./commands/check-run-leases.command.ts";
import { checkRunLeasesHandler } from "./commands/check-run-leases.handler.ts";
import { PlanTickCommand } from "./commands/plan-tick.command.ts";
import { planTickHandler } from "./commands/plan-tick.handler.ts";

// What changes the runs and what they hold. The handlers take the stores in
// state.db and the flows a process loaded from the composition root that
// holds them (the daemon), as the runs' queries do.
export const runsCommandGroup = Command.group(CheckRunLeasesCommand, PlanTickCommand);

const RunsCommandHandlersLive = Command.handlersOf(runsCommandGroup, {
  CheckRunLeasesCommand: (payload) => checkRunLeasesHandler(payload),
  PlanTickCommand: (payload) => planTickHandler(payload),
});

// The runs module's slice of the write side, which the daemon dispatches to
// check and renew its runs' leases and to plan each tick of a flow.
export class RunsCommands extends Context.Service<
  RunsCommands,
  Command.Dispatcher<typeof runsCommandGroup>
>()("RunsCommands") {}

export const RunsCommandsLive = Layer.effect(
  RunsCommands,
  Command.dispatcher(runsCommandGroup),
).pipe(Layer.provideMerge(RunsCommandHandlersLive));
