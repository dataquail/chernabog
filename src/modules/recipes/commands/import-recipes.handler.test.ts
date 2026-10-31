import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { manifestOf, manifestWith, recipeRepo } from "../../../../test/recipe-repo.ts";
import { FlowImportSpecifications } from "../domain/flow-import/flow-import.specification.ts";
import { FlowImportsRepository } from "../domain/flow-import/flow-imports.repository.ts";
import { importRecipesHandler } from "./import-recipes.handler.ts";

// What the checkout imports, as `<root>/<flow>` and its from.
const importedFlows = FlowImportsRepository.use((imports) =>
  imports.findMany(FlowImportSpecifications.inCheckout("/repo")),
).pipe(
  Effect.map((found) => found.map((each) => [`${each.root}/${each.flow}`, each.from] as const)),
);

describe("importRecipesHandler", () => {
  const repo = recipeRepo(
    {
      ".chernabog/package.json": manifestWith({
        "@chernabog/recipes": "0.1.0",
        "@acme/recipes": "1.0.0",
      }),
      ".chernabog/flows/implement.ts": "ours\n",
    },
    false,
    { "re-review": "@acme/recipes/deploy" },
  );

  effect(
    "writes each recipe's from, copying nothing, keeping a flow the repo has, and moves its package to dependencies",
    () =>
      Effect.gen(function* () {
        const imported = yield* importRecipesHandler({
          root: "/repo",
          names: ["review", "implement", "re-review", "@acme/recipes/deploy"],
        });

        expect(imported.flows.map((flow) => [flow.flow, flow.outcome, flow.keptFor])).toEqual([
          ["review", "imported", Option.none()],
          ["implement", "kept", Option.some(".chernabog/flows/implement.ts")],
          ["re-review", "kept", Option.some("@acme/recipes/deploy")],
          ["deploy", "imported", Option.none()],
        ]);
        expect(yield* importedFlows).toEqual([
          ["/repo/re-review", "@acme/recipes/deploy"],
          ["/repo/review", "@chernabog/recipes/review"],
          ["/repo/deploy", "@acme/recipes/deploy"],
        ]);
        expect(repo.stored["/repo/.chernabog/flows/review.ts"]).toBeUndefined();
        expect(imported.dependencies).toEqual(["@chernabog/recipes", "@acme/recipes"]);

        const manifest = manifestOf(repo.stored);
        expect(manifest.dependencies).toEqual({
          "@chernabog/recipes": "0.1.0",
          "@acme/recipes": "1.0.0",
        });
        expect(manifest.devDependencies).toEqual({ "@chernabog/sdk": "0.6.0" });

        const again = yield* importRecipesHandler({ root: "/repo", names: ["review"] });
        expect(again.flows.map((flow) => flow.outcome)).toEqual(["present"]);
        expect(again.dependencies).toEqual([]);
      }).pipe(Effect.provide(repo.layer)),
  );
});
