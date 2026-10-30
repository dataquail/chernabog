import { Command } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { CleanUpScenarioCommand } from "./commands/clean-up-scenario.command.ts";
import { cleanUpScenarioHandler } from "./commands/clean-up-scenario.handler.ts";
import { SeedScenarioCommand } from "./commands/seed-scenario.command.ts";
import { seedScenarioHandler } from "./commands/seed-scenario.handler.ts";
import { RehearsalsLayer } from "./rehearsals.layer.ts";

export const rehearsalsCommandGroup = Command.group(CleanUpScenarioCommand, SeedScenarioCommand);

const RehearsalsCommandHandlersLive = Command.handlersOf(rehearsalsCommandGroup, {
  CleanUpScenarioCommand: (payload) => cleanUpScenarioHandler(payload),
  SeedScenarioCommand: (payload) => seedScenarioHandler(payload),
}).pipe(Layer.provide(RehearsalsLayer));

// The rehearsals module's slice of the write side, which `rehearse`
// dispatches to seed a scenario's repo and clean it up after.
export class RehearsalsCommands extends Context.Service<
  RehearsalsCommands,
  Command.Dispatcher<typeof rehearsalsCommandGroup>
>()("RehearsalsCommands") {}

export const RehearsalsCommandsLive = Layer.effect(
  RehearsalsCommands,
  Command.dispatcher(rehearsalsCommandGroup),
).pipe(Layer.provideMerge(RehearsalsCommandHandlersLive));
