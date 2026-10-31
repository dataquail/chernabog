import { Query } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { diffRecipesHandler } from "./queries/diff-recipes.handler.ts";
import { DiffRecipesQuery } from "./queries/diff-recipes.query.ts";
import { listRecipesHandler } from "./queries/list-recipes.handler.ts";
import { ListRecipesQuery } from "./queries/list-recipes.query.ts";
import { readTeamConfigHandler } from "./queries/read-team-config.handler.ts";
import { ReadTeamConfigQuery } from "./queries/read-team-config.query.ts";

export const recipesQueryGroup = Query.group(
  DiffRecipesQuery,
  ListRecipesQuery,
  ReadTeamConfigQuery,
);

const RecipesQueryHandlersLive = Query.handlersOf(recipesQueryGroup, {
  DiffRecipesQuery: (payload) => diffRecipesHandler(payload),
  ListRecipesQuery: (payload) => listRecipesHandler(payload),
  ReadTeamConfigQuery: (payload) => readTeamConfigHandler(payload),
});

// The recipes module's slice of the read side, which `recipes` and `init` ask,
// and of which enrollment asks the team's config (recipes.exports.ts).
export class RecipesQueries extends Context.Service<
  RecipesQueries,
  Query.Dispatcher<typeof recipesQueryGroup>
>()("RecipesQueries") {}

export const RecipesQueriesLive = Layer.effect(
  RecipesQueries,
  Query.dispatcher(recipesQueryGroup),
).pipe(Layer.provideMerge(RecipesQueryHandlersLive));
