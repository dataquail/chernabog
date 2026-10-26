import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { RecipeRoot } from "./recipe.root.ts";
import { RecipeRootOps } from "./recipe.root-ops.ts";
import { type RecipePackage } from "./recipe-package.value-object.ts";

const recipe = (pkg: string, name: string, prompts: ReadonlyArray<string> = []) =>
  RecipeRoot.make({
    package: pkg,
    version: "1.0.0",
    name,
    description: `the ${name} recipe`,
    flow: `flows/${name}.ts`,
    prompts,
    stages: [],
    docs: Option.some(`https://docs/${name}/`),
  });

const pkg = (name: string, recipes: ReadonlyArray<RecipeRoot>): RecipePackage => ({
  name,
  version: "1.0.0",
  sdkRange: Option.some("^0.6.0"),
  recipes,
});

const official = pkg("@chernabog/recipes", [
  recipe("@chernabog/recipes", "implement", ["prompts/implement.md"]),
  recipe("@chernabog/recipes", "review"),
]);

const acme = pkg("@acme/r", [recipe("@acme/r", "deploy"), recipe("@acme/r", "review")]);

describe("RecipeRootOps", () => {
  test("a recipe brings its flow first, then its prompts, and is named bare from the official package", () => {
    const [implement] = official.recipes;
    expect(RecipeRootOps.filesOf(implement)).toEqual([
      "flows/implement.ts",
      "prompts/implement.md",
    ]);
    expect(RecipeRootOps.refOf(implement)).toBe("implement");
    expect(RecipeRootOps.refOf(acme.recipes[0])).toBe("@acme/r/deploy");
  });

  test("names each recipe once, across packages, and refuses one that isn't, naming the ones that are", () => {
    expect(
      Result.map(
        RecipeRootOps.allNamed([acme, official], ["review", "@acme/r/deploy", "review"]),
        (found) => found.map(RecipeRootOps.refOf),
      ),
    ).toEqual(Result.succeed(["review", "@acme/r/deploy"]));

    const unknown = RecipeRootOps.allNamed([acme, official], ["review", "deploy"]);
    expect(Result.isFailure(unknown) && unknown.failure.message).toBe(
      "no recipe named deploy (there are: implement, review, @acme/r/deploy, @acme/r/review)",
    );

    const missing = RecipeRootOps.allNamed([official], ["@globex/r/ship"]);
    expect(Result.isFailure(missing) && missing.failure.message).toContain(
      "@globex/r isn't installed in .chernabog/",
    );
  });

  test("a repo has copied the recipes whose flow file it has, the official one where two bring it", () => {
    const copied = RecipeRootOps.copiedIn([acme, official], (file) =>
      ["flows/review.ts", "flows/deploy.ts"].includes(file),
    );

    expect(copied.map(RecipeRootOps.refOf)).toEqual(["review", "@acme/r/deploy"]);
  });
});
