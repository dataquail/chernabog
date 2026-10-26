import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";

import {
  formatRecipeRef,
  parseRecipeRef,
  RecipePackageManifest,
} from "./recipe-package.value-object.ts";

const decode = Schema.decodeUnknownExit(RecipePackageManifest);

describe("the recipe package format", () => {
  test("a bare name is the official package's, and a package keeps its scope", () => {
    expect(parseRecipeRef("review")).toEqual({ package: "@chernabog/recipes", name: "review" });
    expect(parseRecipeRef("@acme/chernabog-recipes/deploy")).toEqual({
      package: "@acme/chernabog-recipes",
      name: "deploy",
    });
    expect(parseRecipeRef("acme-recipes/deploy")).toEqual({
      package: "acme-recipes",
      name: "deploy",
    });
    expect(formatRecipeRef(parseRecipeRef("@chernabog/recipes/review"))).toBe("review");
    expect(formatRecipeRef(parseRecipeRef("@acme/r/deploy"))).toBe("@acme/r/deploy");
  });

  test("files keep the layout of .chernabog/", () => {
    const manifest = (recipe: {
      readonly flow: string;
      readonly prompts?: ReadonlyArray<string>;
    }) => ({
      name: "@acme/r",
      version: "1.0.0",
      chernabog: { recipes: { deploy: { description: "Deploys", ...recipe } } },
    });

    expect(decode(manifest({ flow: "flows/deploy.ts", prompts: ["prompts/deploy.md"] }))._tag).toBe(
      "Success",
    );
    expect(decode(manifest({ flow: "src/deploy.ts" }))._tag).toBe("Failure");
    expect(decode(manifest({ flow: "flows/deploy.ts", prompts: ["deploy.md"] }))._tag).toBe(
      "Failure",
    );
  });
});
