import { Command } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { ApplySetupCommand } from "./commands/apply-setup.command.ts";
import { applySetupHandler } from "./commands/apply-setup.handler.ts";
import { InstallServiceCommand } from "./commands/install-service.command.ts";
import { installServiceHandler } from "./commands/install-service.handler.ts";
import { StartServiceCommand } from "./commands/start-service.command.ts";
import { startServiceHandler } from "./commands/start-service.handler.ts";
import { StopServiceCommand } from "./commands/stop-service.command.ts";
import { stopServiceHandler } from "./commands/stop-service.handler.ts";
import { UninstallServiceCommand } from "./commands/uninstall-service.command.ts";
import { uninstallServiceHandler } from "./commands/uninstall-service.handler.ts";

export const machineCommandGroup = Command.group(
  ApplySetupCommand,
  InstallServiceCommand,
  StartServiceCommand,
  StopServiceCommand,
  UninstallServiceCommand,
);

const MachineCommandHandlersLive = Command.handlersOf(machineCommandGroup, {
  ApplySetupCommand: (payload) => applySetupHandler(payload),
  InstallServiceCommand: () => installServiceHandler(),
  StartServiceCommand: () => startServiceHandler(),
  StopServiceCommand: () => stopServiceHandler(),
  UninstallServiceCommand: () => uninstallServiceHandler(),
});

// The machine module's slice of the write side, which setup, install,
// uninstall, start and stop dispatch.
export class MachineCommands extends Context.Service<
  MachineCommands,
  Command.Dispatcher<typeof machineCommandGroup>
>()("MachineCommands") {}

export const MachineCommandsLive = Layer.effect(
  MachineCommands,
  Command.dispatcher(machineCommandGroup),
).pipe(Layer.provideMerge(MachineCommandHandlersLive));
