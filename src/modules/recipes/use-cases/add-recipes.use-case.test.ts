import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { effect } from "../../../../test/effect-test.ts";
import { BundleClientFake } from "../infrastructure/clients/bundle.client-fake.ts";
import { ChernabogDirClientFake } from "../infrastructure/clients/chernabog-dir.client-fake.ts";
import { TextDiffClientFake } from "../infrastructure/clients/text-diff.client-fake.ts";
import { addRecipesUseCase } from "./add-recipes.use-case.ts";

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

describe("addRecipesUseCase", () => {
  const repo = repoWith({ ".chernabog/flows/review.ts": "ours\n" });

  effect("writes each recipe's files, keeping the repo's own flow and a prompt already there", () =>
    Effect.gen(function* () {
      const added = yield* addRecipesUseCase("/repo", ["review", "re-review"]);

      expect(added.files.map((file) => [file.outcome, file.file])).toEqual([
        ["kept", ".chernabog/flows/review.ts"],
        ["wrote", ".chernabog/prompts/review.md"],
        ["wrote", ".chernabog/flows/re-review.ts"],
      ]);
      expect(repo.stored["/repo/.chernabog/flows/review.ts"]).toBe("ours\n");
      expect(repo.stored["/repo/.chernabog/flows/re-review.ts"]).toBe(
        "recipe of flows/re-review.ts\n",
      );
    }).pipe(Effect.provide(repo.layer)),
  );

  const fresh = repoWith({});

  effect("refuses a name that isn't a recipe, writing nothing", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(addRecipesUseCase("/repo", ["implement", "ship"]));

      expect(refused._tag).toBe("UnknownRecipe");
      expect(fresh.stored).toEqual({});
    }).pipe(Effect.provide(fresh.layer)),
  );
});
