// The platform surface: what the composition roots and the inbound adapters name to
// assemble and drive this module — its dispatchers, its Layers, and the results and
// value objects its messages answer with. It declares nothing; anything not
// re-exported here is private to the module.

export { type RecipePackageAdded } from "./commands/add-recipe-package.command.ts";
export { type RecipesAdded } from "./commands/add-recipes.command.ts";
export { type RecipeEjected } from "./commands/eject-recipe.command.ts";
export { type RecipesImported } from "./commands/import-recipes.command.ts";
export { type Scaffolded } from "./commands/scaffold-repo.command.ts";
export { type RecipesUpdated, type Unrecorded } from "./commands/update-recipes.command.ts";
export { type RepoUpgraded } from "./commands/upgrade-repo.command.ts";
export { type RecipesDiff } from "./queries/diff-recipes.query.ts";
export { type RecipeList } from "./queries/list-recipes.query.ts";
export { RecipesCommands } from "./recipes.command-handlers.ts";
export { RecipesModule } from "./recipes.module.ts";
export { RecipesQueries } from "./recipes.query-handlers.ts";
