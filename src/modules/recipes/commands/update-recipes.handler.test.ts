import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { jsonText, manifestOf, recipeRepo } from "../../../../test/recipe-repo.ts";
import { updateRecipesHandler } from "./update-recipes.handler.ts";

const copied = (version: string) => ({ from: "@chernabog/recipes", version });

const manifest = jsonText({
  devDependencies: { "@chernabog/sdk": "0.6.0", "@chernabog/recipes": "0.1.0" },
  chernabog: {
    copied: {
      "flows/implement.ts": { ...copied("0.1.0"), from: "@chernabog/recipes/implement" },
      "flows/review.ts": { ...copied("0.1.0"), from: "@chernabog/recipes/review" },
      "prompts/review.md": { ...copied("0.1.0"), from: "@chernabog/recipes/review" },
    },
  },
});

describe("updateRecipesHandler", () => {
  const repo = recipeRepo({
    ".chernabog/package.json": manifest,
    // Edited here, on a line upstream didn't touch.
    ".chernabog/flows/implement.ts": "implement\nconcurrency 3\n",
    // Unedited since 0.1.0.
    ".chernabog/flows/review.ts": "review\n",
    ".chernabog/prompts/review.md": "review prompt\n",
    // Copied before versions were recorded, and edited.
    ".chernabog/flows/re-review.ts": "re-review, ours\n",
  });

  effect(
    "moves the package to the newest version for the repo's SDK, replaces unedited files, merges edited ones and adopts unrecorded ones",
    () =>
      Effect.gen(function* () {
        const updated = yield* updateRecipesHandler({
          root: "/repo",
          names: [],
          unrecorded: "adopt",
        });

        expect(updated.packages).toEqual([
          { name: "@chernabog/recipes", from: "0.1.0", to: "0.2.0" },
        ]);
        expect(updated.changes.map((change) => [change.file, change.change, change.to])).toEqual([
          [".chernabog/flows/implement.ts", "conflicted", "0.2.0"],
          [".chernabog/prompts/implement.md", "written", "0.2.0"],
          [".chernabog/flows/review.ts", "updated", "0.2.0"],
          [".chernabog/flows/re-review.ts", "adopted", "0.2.0"],
        ]);
        expect(repo.stored["/repo/.chernabog/flows/review.ts"]).toBe("review\nupstream fix\n");
        expect(repo.stored["/repo/.chernabog/flows/re-review.ts"]).toBe("re-review, ours\n");

        const records = manifestOf(repo.stored);
        expect(records.devDependencies?.["@chernabog/recipes"]).toBe("0.2.0");
        expect(records.chernabog?.copied?.["flows/re-review.ts"]).toEqual({
          from: "@chernabog/recipes/re-review",
          version: "0.2.0",
        });
        expect(records.chernabog?.copied?.["prompts/review.md"]?.version).toBe("0.2.0");

        const again = yield* updateRecipesHandler({
          root: "/repo",
          names: [],
          unrecorded: "adopt",
        });

        expect(again.packages).toEqual([]);
        expect(again.changes).toEqual([]);
      }).pipe(Effect.provide(repo.layer)),
  );

  const uncopied = recipeRepo({ ".chernabog/flows/review.ts": "review\n" });

  effect("leaves a named recipe the repo hasn't copied for recipes add", () =>
    Effect.gen(function* () {
      const updated = yield* updateRecipesHandler({
        root: "/repo",
        names: ["implement"],
        unrecorded: "adopt",
      });

      expect(updated.changes).toEqual([]);
      expect(uncopied.stored["/repo/.chernabog/flows/implement.ts"]).toBeUndefined();
    }).pipe(Effect.provide(uncopied.layer)),
  );

  const legacy = recipeRepo({ ".chernabog/flows/review.ts": "old review\n" });

  effect(
    "replaces an unrecorded file that differs, when asked to, as moving to a new SDK does",
    () =>
      Effect.gen(function* () {
        const updated = yield* updateRecipesHandler({
          root: "/repo",
          names: ["review"],
          unrecorded: "replace",
        });

        expect(updated.changes.map((change) => [change.file, change.change])).toEqual([
          [".chernabog/flows/review.ts", "replaced"],
          [".chernabog/prompts/review.md", "written"],
        ]);
        expect(legacy.stored["/repo/.chernabog/flows/review.ts"]).toBe("review\nupstream fix\n");
      }).pipe(Effect.provide(legacy.layer)),
  );

  const offline = recipeRepo({ ".chernabog/flows/review.ts": "review\n" }, true);

  effect("fails, writing nothing, when the registry can't be reached", () =>
    Effect.gen(function* () {
      const before = { ...offline.stored };

      const failed = yield* Effect.flip(
        updateRecipesHandler({ root: "/repo", names: [], unrecorded: "adopt" }),
      );

      expect(failed._tag).toBe("RecipePackageUnavailable");
      expect(offline.stored).toEqual(before);
    }).pipe(Effect.provide(offline.layer)),
  );
});
