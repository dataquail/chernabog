import { Command } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ownUnitOfWork } from "../../platform/unit-of-work.ts";
import { CleanUpScenarioCommand } from "./commands/clean-up-scenario.command.ts";
import { cleanUpScenarioHandler } from "./commands/clean-up-scenario.handler.ts";
import { SeedScenarioCommand } from "./commands/seed-scenario.command.ts";
import { seedScenarioHandler } from "./commands/seed-scenario.handler.ts";

export const rehearsalsCommandGroup = Command.group(CleanUpScenarioCommand, SeedScenarioCommand);

const RehearsalsCommandHandlersLive = Command.handlersOf(rehearsalsCommandGroup, {
  CleanUpScenarioCommand: (payload) => cleanUpScenarioHandler(payload),
  SeedScenarioCommand: (payload) => seedScenarioHandler(payload),
});

// The rehearsals module's slice of the write side, which `rehearse`
// dispatches to seed a scenario's repo and clean it up after.
export class RehearsalsCommands extends Context.Service<
  RehearsalsCommands,
  Command.Dispatcher<typeof rehearsalsCommandGroup>
>()("RehearsalsCommands") {}

export const RehearsalsCommandsLive = Layer.effect(
  RehearsalsCommands,
  Effect.flatMap(ownUnitOfWork, (own) =>
    Command.dispatcher(rehearsalsCommandGroup, { middleware: [own] }),
  ),
).pipe(Layer.provideMerge(RehearsalsCommandHandlersLive));
