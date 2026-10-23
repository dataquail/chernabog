import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { effect } from "../../../../test/effect-test.ts";
import { BundleClientFake } from "../infrastructure/clients/bundle.client-fake.ts";
import { ChernabogDirClientFake } from "../infrastructure/clients/chernabog-dir.client-fake.ts";
import { TextDiffClientFake } from "../infrastructure/clients/text-diff.client-fake.ts";
import { listRecipesUseCase } from "./list-recipes.use-case.ts";

const SCAFFOLD = {
  files: { "config.yaml": "flows: {}\n", "config.schema.json": "{ schema }\n" },
  generated: ["config.schema.json"],
  manifest: "{ }\n",
};

// A checkout at /repo holding `files`, by path under it.
const repoWith = (files: Record<string, string>) => {
  const stored: Record<string, string> = Object.fromEntries(
    Object.entries(files).map(([path, text]) => [`/repo/${path}`, text]),
  );

  return {
    stored,
    layer: Layer.mergeAll(
      ChernabogDirClientFake(stored),
      BundleClientFake(SCAFFOLD),
      TextDiffClientFake,
    ),
  };
};

describe("listRecipesUseCase", () => {
  const repo = repoWith({ ".chernabog/flows/review.ts": "ours\n" });

  effect("lists every recipe, with whether the repo has its flow", () =>
    Effect.gen(function* () {
      const { recipes } = yield* listRecipesUseCase("/repo");

      expect(recipes.filter((recipe) => recipe.installed).map((recipe) => recipe.name)).toEqual([
        "review",
      ]);
      expect(recipes[0].docs).toBe("https://dataquail.github.io/chernabog/recipes/implement/");
    }).pipe(Effect.provide(repo.layer)),
  );
});
