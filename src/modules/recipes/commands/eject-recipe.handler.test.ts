import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { manifestOf, recipeRepo } from "../../../../test/recipe-repo.ts";
import { FlowImportSpecifications } from "../domain/flow-import/flow-import.specification.ts";
import { FlowImportsRepository } from "../domain/flow-import/flow-imports.repository.ts";
import { ejectRecipeHandler } from "./eject-recipe.handler.ts";

// What the checkout imports, as `<root>/<flow>` and its from.
const importedFlows = FlowImportsRepository.use((imports) =>
  imports.findMany(FlowImportSpecifications.inCheckout("/repo")),
).pipe(
  Effect.map((found) => found.map((each) => [`${each.root}/${each.flow}`, each.from] as const)),
);

describe("ejectRecipeHandler", () => {
  const repo = recipeRepo({ ".chernabog/prompts/implement.md": "our prompt\n" }, false, {
    ship: "implement",
    review: "@chernabog/recipes/review",
  });

  effect(
    "copies an imported flow in under its own name, keeps a prompt that overrode the package's, records versions and drops the from",
    () =>
      Effect.gen(function* () {
        const ejected = yield* ejectRecipeHandler({ root: "/repo", flow: "ship" });

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
        expect(yield* importedFlows).toEqual([["/repo/review", "@chernabog/recipes/review"]]);
      }).pipe(Effect.provide([repo.layer, PassThroughUnitOfWork])),
  );

  effect("refuses a flow the repo doesn't import, naming the ones it does", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(ejectRecipeHandler({ root: "/repo", flow: "deploy" }));

      expect(refused.message).toBe(
        "config.yaml doesn't import a flow named deploy (it imports: ship, review)",
      );
    }).pipe(Effect.provide([repo.layer, PassThroughUnitOfWork])),
  );
});
