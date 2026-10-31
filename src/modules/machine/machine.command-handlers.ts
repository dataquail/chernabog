import { Command } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ownUnitOfWork } from "../../platform/unit-of-work.ts";
import { ApplySetupCommand } from "./commands/apply-setup.command.ts";
import { applySetupHandler } from "./commands/apply-setup.handler.ts";
import { InstallServiceCommand } from "./commands/install-service.command.ts";
import { installServiceHandler } from "./commands/install-service.handler.ts";
import { RefreshServiceCommand } from "./commands/refresh-service.command.ts";
import { refreshServiceHandler } from "./commands/refresh-service.handler.ts";
import { StartServiceCommand } from "./commands/start-service.command.ts";
import { startServiceHandler } from "./commands/start-service.handler.ts";
import { StopServiceCommand } from "./commands/stop-service.command.ts";
import { stopServiceHandler } from "./commands/stop-service.handler.ts";
import { UninstallServiceCommand } from "./commands/uninstall-service.command.ts";
import { uninstallServiceHandler } from "./commands/uninstall-service.handler.ts";

export const machineCommandGroup = Command.group(
  ApplySetupCommand,
  InstallServiceCommand,
  RefreshServiceCommand,
  StartServiceCommand,
  StopServiceCommand,
  UninstallServiceCommand,
);

const MachineCommandHandlersLive = Command.handlersOf(machineCommandGroup, {
  ApplySetupCommand: (payload) => applySetupHandler(payload),
  InstallServiceCommand: () => installServiceHandler(),
  RefreshServiceCommand: () => refreshServiceHandler(),
  StartServiceCommand: () => startServiceHandler(),
  StopServiceCommand: () => stopServiceHandler(),
  UninstallServiceCommand: () => uninstallServiceHandler(),
});

// The machine module's slice of the write side, which setup, install,
// uninstall, start and stop dispatch, and the daemon as it starts.
export class MachineCommands extends Context.Service<
  MachineCommands,
  Command.Dispatcher<typeof machineCommandGroup>
>()("MachineCommands") {}

export const MachineCommandsLive = Layer.effect(
  MachineCommands,
  Effect.flatMap(ownUnitOfWork, (own) =>
    Command.dispatcher(machineCommandGroup, { middleware: [own] }),
  ),
).pipe(Layer.provideMerge(MachineCommandHandlersLive));
