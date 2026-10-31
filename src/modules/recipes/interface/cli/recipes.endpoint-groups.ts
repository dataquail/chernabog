// The recipes module's CLI endpoints, which the CLI's root registers as its
// subcommands (docs/adr/0013-inbound-adapters-live-in-their-module.md).

import { recipesEndpoint } from "./recipes.endpoint.ts";

export const recipesEndpoints = {
  recipes: recipesEndpoint,
};

// What `init`, which the CLI's root composes from this module and enrollment,
// takes of the recipes: the flag naming them, baking them, and the schemas
// that describe their settings.
export { bakeRecipes, recipesFlag, refreshSchemas } from "./recipes.endpoint.ts";
