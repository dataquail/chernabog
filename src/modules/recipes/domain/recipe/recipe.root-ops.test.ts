import { describe, expect, test } from "bun:test";
import * as Result from "effect/Result";

import { RecipeRootOps } from "./recipe.root-ops.ts";
import { RECIPES } from "./recipe-catalog.value-object.ts";

describe("RecipeRootOps", () => {
  test("each recipe brings its own flow first, named for it, and has a docs page", () => {
    for (const recipe of RECIPES) {
      expect(RecipeRootOps.flowFileOf(recipe)).toBe(`flows/${recipe.name}.ts`);
      expect(RecipeRootOps.docsOf(recipe)).toBe(
        `https://dataquail.github.io/chernabog/recipes/${recipe.name}/`,
      );
    }
  });

  test("names each recipe once, and refuses one that isn't, naming the ones that are", () => {
    expect(
      Result.map(RecipeRootOps.allNamed(["review", "implement", "review"]), (found) =>
        found.map((recipe) => recipe.name),
      ),
    ).toEqual(Result.succeed(["review", "implement"]));

    const unknown = RecipeRootOps.allNamed(["review", "deploy"]);
    expect(Result.isFailure(unknown) && unknown.failure.message).toBe(
      "no recipe named deploy (there are: implement, review, re-review, address-review, human-initiated)",
    );
  });

  test("a repo has the recipes whose flow file it has", () => {
    expect(
      RecipeRootOps.installed((file) => file === "flows/review.ts").map((recipe) => recipe.name),
    ).toEqual(["review"]);
  });
});
