import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { jsonText, scratchRecipeRepos } from "../../../../test/recipe-repo.ts";
import { Exec } from "../../../platform/exec.ts";
import { TextDiffClientLive } from "../infrastructure/clients/text-diff.client-live.ts";
import { diffRecipesHandler } from "./diff-recipes.handler.ts";

const manifest = jsonText({
  devDependencies: { "@chernabog/sdk": "0.6.0", "@chernabog/recipes": "0.2.0" },
  chernabog: {
    copied: { "flows/review.ts": { from: "@chernabog/recipes/review", version: "0.1.0" } },
  },
});

describe("diffRecipesHandler", () => {
  const repos = scratchRecipeRepos();

  // git diffs for real.
  const layer = Layer.mergeAll(repos.layer, TextDiffClientLive.pipe(Layer.provide(Exec.layer)));

  // A checkout on disk that copied review at 0.1.0 and edited it, holds the
  // prompt as 0.2.0 has it, and has a flow of its own.
  const checkout = repos.checkout({
    ".chernabog/package.json": manifest,
    ".chernabog/flows/review.ts": "review\nedited\n",
    ".chernabog/prompts/review.md": "review prompt\n",
    ".chernabog/flows/security.ts": "ours\n",
  });

  effect(
    "sets each copied file against the version it came from, else the one installed, and lists the flows from none",
    () =>
      Effect.gen(function* () {
        const root = yield* checkout;

        const { files } = yield* diffRecipesHandler({ root, names: [] });

        expect(files.map((file) => [file.file, file.state, file.version, file.recorded])).toEqual([
          [".chernabog/flows/review.ts", "differs", Option.some("@chernabog/recipes@0.1.0"), true],
          [".chernabog/prompts/review.md", "same", Option.some("@chernabog/recipes@0.2.0"), false],
          [".chernabog/flows/security.ts", "unowned", Option.none(), false],
        ]);
        const diff = Option.getOrElse(files[0].diff, () => "");
        expect(diff).toContain("--- recipe/.chernabog/flows/review.ts");
        expect(diff).toContain("+++ repo/.chernabog/flows/review.ts");
        expect(diff).toContain(" review\n+edited");
        expect(files[1].diff).toEqual(Option.none());
      }).pipe(Effect.provide(layer)),
  );

  effect("with names, only those recipes, saying which files the repo lacks", () =>
    Effect.gen(function* () {
      const root = yield* checkout;

      const { files } = yield* diffRecipesHandler({ root, names: ["implement"] });

      expect(files.map((file) => [file.file, file.state])).toEqual([
        [".chernabog/flows/implement.ts", "missing"],
        [".chernabog/prompts/implement.md", "missing"],
      ]);
    }).pipe(Effect.provide(layer)),
  );
});
