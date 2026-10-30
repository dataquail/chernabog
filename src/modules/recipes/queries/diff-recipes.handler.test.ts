import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { jsonText, recipeRepo } from "../../../../test/recipe-repo.ts";
import { diffRecipesHandler } from "./diff-recipes.handler.ts";

const manifest = jsonText({
  devDependencies: { "@chernabog/sdk": "0.6.0", "@chernabog/recipes": "0.2.0" },
  chernabog: {
    copied: { "flows/review.ts": { from: "@chernabog/recipes/review", version: "0.1.0" } },
  },
});

describe("diffRecipesHandler", () => {
  const repo = recipeRepo({
    ".chernabog/package.json": manifest,
    ".chernabog/flows/review.ts": "review\nedited\n",
    ".chernabog/prompts/review.md": "review prompt\n",
    ".chernabog/flows/security.ts": "ours\n",
  });

  effect(
    "sets each copied file against the version it came from, else the one installed, and lists the flows from none",
    () =>
      Effect.gen(function* () {
        const { files } = yield* diffRecipesHandler({ root: "/repo", names: [] });

        expect(files.map((file) => [file.file, file.state, file.version, file.recorded])).toEqual([
          [".chernabog/flows/review.ts", "differs", Option.some("@chernabog/recipes@0.1.0"), true],
          [".chernabog/prompts/review.md", "same", Option.some("@chernabog/recipes@0.2.0"), false],
          [".chernabog/flows/security.ts", "unowned", Option.none(), false],
        ]);
        expect(files[0].diff).toEqual(Option.some("-review\n+review\nedited (flows/review.ts)"));
      }).pipe(Effect.provide(repo.layer)),
  );

  effect("with names, only those recipes, saying which files the repo lacks", () =>
    Effect.gen(function* () {
      const { files } = yield* diffRecipesHandler({ root: "/repo", names: ["implement"] });

      expect(files.map((file) => [file.file, file.state])).toEqual([
        [".chernabog/flows/implement.ts", "missing"],
        [".chernabog/prompts/implement.md", "missing"],
      ]);
    }).pipe(Effect.provide(repo.layer)),
  );
});
