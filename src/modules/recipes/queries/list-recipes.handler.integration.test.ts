import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { manifestWith, scratchRecipeRepos } from "../../../../test/recipe-repo.ts";
import { listRecipesHandler } from "./list-recipes.handler.ts";

describe("listRecipesHandler", () => {
  const repos = scratchRecipeRepos();

  effect(
    "lists the recipes of every installed package, the official first, with whether the repo copied or imported each",
    () =>
      Effect.gen(function* () {
        const root = yield* repos.checkout({
          ".chernabog/package.json": manifestWith({
            "@chernabog/recipes": "0.1.0",
            "@acme/recipes": "1.0.0",
          }),
          ".chernabog/flows/review.ts": "ours\n",
          ".chernabog/config.yaml": 'flows:\n  deploy:\n    from: "@acme/recipes/deploy"\n',
        });

        const { packages, recipes } = yield* listRecipesHandler({ root });

        expect(packages).toEqual([
          { name: "@chernabog/recipes", version: "0.1.0" },
          { name: "@acme/recipes", version: "1.0.0" },
        ]);
        expect(recipes.map((recipe) => [recipe.ref, recipe.state])).toEqual([
          ["implement", "available"],
          ["review", "copied"],
          ["re-review", "available"],
          ["@acme/recipes/deploy", "imported"],
        ]);
        expect(recipes[0].docs).toEqual(Option.some("https://docs/implement/"));
      }).pipe(Effect.provide(repos.layer)),
  );
});
