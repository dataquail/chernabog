import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { manifestOf, recipeRepo } from "../../../../test/recipe-repo.ts";
import { ejectRecipeUseCase } from "./eject-recipe.use-case.ts";

describe("ejectRecipeUseCase", () => {
  const repo = recipeRepo({ ".chernabog/prompts/implement.md": "our prompt\n" }, false, {
    ship: "implement",
    review: "@chernabog/recipes/review",
  });

  effect(
    "copies an imported flow in under its own name, keeps a prompt that overrode the package's, records versions and drops the from",
    () =>
      Effect.gen(function* () {
        const ejected = yield* ejectRecipeUseCase("/repo", "ship");

        expect(ejected.files.map((file) => [file.outcome, file.file])).toEqual([
          ["wrote", ".chernabog/flows/ship.ts"],
          ["kept", ".chernabog/prompts/implement.md"],
        ]);
        expect(repo.stored["/repo/.chernabog/flows/ship.ts"]).toBe("implement\nconcurrency 1\n");
        expect(repo.stored["/repo/.chernabog/prompts/implement.md"]).toBe("our prompt\n");
        expect(manifestOf(repo.stored).chernabog?.copied).toEqual({
          "flows/ship.ts": {
            from: "@chernabog/recipes/implement",
            version: "0.1.0",
            file: "flows/implement.ts",
          },
        });
        expect([...repo.imports]).toEqual([["/repo/review", "@chernabog/recipes/review"]]);
      }).pipe(Effect.provide(repo.layer)),
  );

  effect("refuses a flow the repo doesn't import, naming the ones it does", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(ejectRecipeUseCase("/repo", "deploy"));

      expect(refused.message).toBe(
        "config.yaml doesn't import a flow named deploy (it imports: review)",
      );
    }).pipe(Effect.provide(repo.layer)),
  );
});
