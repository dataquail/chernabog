import { Command } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ownUnitOfWork } from "../../platform/unit-of-work.ts";
import { AddRecipePackageCommand } from "./commands/add-recipe-package.command.ts";
import { addRecipePackageHandler } from "./commands/add-recipe-package.handler.ts";
import { AddRecipesCommand } from "./commands/add-recipes.command.ts";
import { addRecipesHandler } from "./commands/add-recipes.handler.ts";
import { EjectRecipeCommand } from "./commands/eject-recipe.command.ts";
import { ejectRecipeHandler } from "./commands/eject-recipe.handler.ts";
import { ImportRecipesCommand } from "./commands/import-recipes.command.ts";
import { importRecipesHandler } from "./commands/import-recipes.handler.ts";
import { ScaffoldRepoCommand } from "./commands/scaffold-repo.command.ts";
import { scaffoldRepoHandler } from "./commands/scaffold-repo.handler.ts";
import { UpdateRecipesCommand } from "./commands/update-recipes.command.ts";
import { updateRecipesHandler } from "./commands/update-recipes.handler.ts";
import { UpgradeRepoCommand } from "./commands/upgrade-repo.command.ts";
import { upgradeRepoHandler } from "./commands/upgrade-repo.handler.ts";

export const recipesCommandGroup = Command.group(
  AddRecipePackageCommand,
  AddRecipesCommand,
  EjectRecipeCommand,
  ImportRecipesCommand,
  ScaffoldRepoCommand,
  UpdateRecipesCommand,
  UpgradeRepoCommand,
);

const RecipesCommandHandlersLive = Command.handlersOf(recipesCommandGroup, {
  AddRecipePackageCommand: (payload) => addRecipePackageHandler(payload),
  AddRecipesCommand: (payload) => addRecipesHandler(payload),
  EjectRecipeCommand: (payload) => ejectRecipeHandler(payload),
  ImportRecipesCommand: (payload) => importRecipesHandler(payload),
  ScaffoldRepoCommand: (payload) => scaffoldRepoHandler(payload),
  UpdateRecipesCommand: (payload) => updateRecipesHandler(payload),
  UpgradeRepoCommand: (payload) => upgradeRepoHandler(payload),
});

// The recipes module's slice of the write side, which `recipes` and `init`
// dispatch.
export class RecipesCommands extends Context.Service<
  RecipesCommands,
  Command.Dispatcher<typeof recipesCommandGroup>
>()("RecipesCommands") {}

export const RecipesCommandsLive = Layer.effect(
  RecipesCommands,
  Effect.flatMap(ownUnitOfWork, (own) =>
    Command.dispatcher(recipesCommandGroup, { middleware: [own] }),
  ),
).pipe(Layer.provideMerge(RecipesCommandHandlersLive));
