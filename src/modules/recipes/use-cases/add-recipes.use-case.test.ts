import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { manifestOf, manifestWith, recipeRepo } from "../../../../test/recipe-repo.ts";
import { addRecipesUseCase } from "./add-recipes.use-case.ts";

describe("addRecipesUseCase", () => {
  const repo = recipeRepo({
    ".chernabog/package.json": manifestWith({
      "@chernabog/recipes": "0.1.0",
      "@acme/recipes": "1.0.0",
    }),
    ".chernabog/flows/review.ts": "ours\n",
  });

  effect(
    "copies each recipe's files from its package, keeping the repo's own flow and a prompt already there, and records each version",
    () =>
      Effect.gen(function* () {
        const added = yield* addRecipesUseCase("/repo", [
          "review",
          "re-review",
          "@acme/recipes/deploy",
        ]);

        expect(
          added.files.map((file) => [file.outcome, file.file, file.recipe, file.version]),
        ).toEqual([
          ["kept", ".chernabog/flows/review.ts", "review", "0.1.0"],
          ["wrote", ".chernabog/prompts/review.md", "review", "0.1.0"],
          ["wrote", ".chernabog/flows/re-review.ts", "re-review", "0.1.0"],
          ["wrote", ".chernabog/flows/deploy.ts", "@acme/recipes/deploy", "1.0.0"],
        ]);
        expect(repo.stored["/repo/.chernabog/flows/review.ts"]).toBe("ours\n");
        expect(repo.stored["/repo/.chernabog/flows/deploy.ts"]).toBe("deploy\n");
        expect(manifestOf(repo.stored).chernabog).toEqual({
          copied: {
            "flows/deploy.ts": { from: "@acme/recipes/deploy", version: "1.0.0" },
            "flows/re-review.ts": { from: "@chernabog/recipes/re-review", version: "0.1.0" },
            "prompts/review.md": { from: "@chernabog/recipes/review", version: "0.1.0" },
          },
        });
      }).pipe(Effect.provide(repo.layer)),
  );

  const fresh = recipeRepo({});

  effect(
    "refuses a name that isn't a recipe, or is from a package that isn't installed, writing nothing",
    () =>
      Effect.gen(function* () {
        const before = { ...fresh.stored };
        const unknown = yield* Effect.flip(addRecipesUseCase("/repo", ["implement", "ship"]));
        const missing = yield* Effect.flip(addRecipesUseCase("/repo", ["@globex/recipes/ship"]));

        expect(unknown._tag).toBe("UnknownRecipe");
        expect(missing.message).toContain("@globex/recipes isn't installed in .chernabog/");
        expect(fresh.stored).toEqual(before);
      }).pipe(Effect.provide(fresh.layer)),
  );
});
