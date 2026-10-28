import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { manifestOf, manifestWith, recipeRepo } from "../../../../test/recipe-repo.ts";
import { addRecipePackageUseCase } from "./add-recipe-package.use-case.ts";

describe("addRecipePackageUseCase", () => {
  const fresh = recipeRepo({ ".chernabog/package.json": manifestWith({}) });

  effect(
    "adds the newest version whose SDK range includes the repo's pin, as a dev dependency",
    () =>
      Effect.gen(function* () {
        const added = yield* addRecipePackageUseCase("/repo", "@chernabog/recipes");

        expect([added.change, added.version]).toEqual(["added", "0.2.0"]);
        expect(manifestOf(fresh.stored).devDependencies?.["@chernabog/recipes"]).toBe("0.2.0");

        const again = yield* addRecipePackageUseCase("/repo", "@chernabog/recipes");
        expect([again.change, again.version]).toEqual(["present", "0.2.0"]);
      }).pipe(Effect.provide(fresh.layer)),
  );

  const offline = recipeRepo({ ".chernabog/package.json": manifestWith({}) }, true);

  effect("fails when the registry can't be reached", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(addRecipePackageUseCase("/repo", "@chernabog/recipes"));

      expect(failed._tag).toBe("RecipePackageUnavailable");
    }).pipe(Effect.provide(offline.layer)),
  );

  const newer = recipeRepo({
    ".chernabog/package.json": manifestWith({ "@chernabog/sdk": "0.7.0" }),
  });

  effect("fails when no version supports the repo's SDK", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(addRecipePackageUseCase("/repo", "@chernabog/recipes"));

      expect(failed.message).toBe("no version of @chernabog/recipes supports @chernabog/sdk 0.7.0");
    }).pipe(Effect.provide(newer.layer)),
  );
});
