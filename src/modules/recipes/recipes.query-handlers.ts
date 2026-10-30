import { Query } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { diffRecipesHandler } from "./queries/diff-recipes.handler.ts";
import { DiffRecipesQuery } from "./queries/diff-recipes.query.ts";
import { listRecipesHandler } from "./queries/list-recipes.handler.ts";
import { ListRecipesQuery } from "./queries/list-recipes.query.ts";
import { RecipesLayer } from "./recipes.layer.ts";

export const recipesQueryGroup = Query.group(DiffRecipesQuery, ListRecipesQuery);

const RecipesQueryHandlersLive = Query.handlersOf(recipesQueryGroup, {
  DiffRecipesQuery: (payload) => diffRecipesHandler(payload),
  ListRecipesQuery: (payload) => listRecipesHandler(payload),
}).pipe(Layer.provide(RecipesLayer));

// The recipes module's slice of the read side, which `recipes` and `init` ask.
export class RecipesQueries extends Context.Service<
  RecipesQueries,
  Query.Dispatcher<typeof recipesQueryGroup>
>()("RecipesQueries") {}

export const RecipesQueriesLive = Layer.effect(
  RecipesQueries,
  Query.dispatcher(recipesQueryGroup),
).pipe(Layer.provideMerge(RecipesQueryHandlersLive));
