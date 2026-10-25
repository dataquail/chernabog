// Recipes: what each one bakes into a repo, that baking never overwrites the
// repo's own flows, and how the ones to bake are chosen.

import { DEFAULT_LABELS } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { Asker } from "../src/interface/cli/asker.prompt.ts";
import { bakeRecipes, diffLines } from "../src/interface/cli/recipes/recipes.command.ts";
import { RecipeRootOps } from "../src/modules/recipes/domain/recipe/recipe.root-ops.ts";
import { RECIPES } from "../src/modules/recipes/domain/recipe/recipe-catalog.value-object.ts";
import { RecipesLayer } from "../src/modules/recipes/recipes.layer.ts";
import { listRecipesUseCase } from "../src/modules/recipes/use-cases/list-recipes.use-case.ts";
import { Exec } from "../src/platform/exec.ts";
import { RECIPE_FILES } from "../src/platform/templates.ts";
import implement from "../templates/recipes/flows/implement.ts";
import { scripted } from "./asker.ts";
import { effect } from "./effect-test.ts";
import { flowTriggered, ISSUE, makeFake } from "./sdk-fakes.ts";

const checkout = FileSystem.FileSystem.use((fs) =>
  fs.makeTempDirectoryScoped({ prefix: "chernabog-recipes-" }),
);

// A recipe file as this binary bundles it.
const recipeText = (file: string) =>
  Option.getOrElse(
    Option.map(
      Arr.findFirst(Object.entries(RECIPE_FILES), ([name]) => name === file),
      ([, text]) => text,
    ),
    () => "",
  );

const recipes = (layer: Layer.Layer<Asker>) =>
  Layer.mergeAll(layer, RecipesLayer).pipe(Layer.provideMerge(Exec.layer));

// Baking the ones named, or, without names, the ones a person picks.
const baking = (
  layer: Layer.Layer<Asker>,
  repo: string,
  named: Option.Option<ReadonlyArray<string>>,
) => bakeRecipes(repo, named).pipe(Effect.provide(recipes(layer)));

const bake = (repo: string, ...names: ReadonlyArray<string>) =>
  baking(Asker.none, repo, Option.some(names));

const installed = (repo: string) =>
  listRecipesUseCase(repo).pipe(
    Effect.map(({ recipes: listed }) =>
      listed.filter((recipe) => recipe.installed).map((recipe) => recipe.name),
    ),
    Effect.provide(recipes(Asker.none)),
  );

describe("the recipes", () => {
  effect("each brings its own flow, named for it, and a docs page", () =>
    Effect.sync(() => {
      for (const recipe of RECIPES) {
        expect(RecipeRootOps.flowFileOf(recipe)).toBe(`flows/${recipe.name}.ts`);
        expect(RecipeRootOps.docsOf(recipe)).toBe(
          `https://dataquail.github.io/chernabog/recipes/${recipe.name}/`,
        );
      }
    }),
  );

  effect("every file under templates/recipes/ belongs to one", () =>
    Effect.sync(() => {
      const owned = new Set<string>(RECIPES.flatMap((recipe) => recipe.files));
      expect(Object.keys(RECIPE_FILES).filter((file) => !owned.has(file))).toEqual([]);
    }),
  );

  effect("none calls a whole workflow of the SDK", () =>
    Effect.sync(() => {
      for (const recipe of RECIPES) {
        expect(recipeText(RecipeRootOps.flowFileOf(recipe))).not.toMatch(
          /\b(Implement|Review)\.(workflow|reReviewWorkflow|addressWorkflow)\b/,
        );
      }
    }),
  );

  effect("nor an SDK trigger, whose filters would hide its policy", () =>
    Effect.sync(() => {
      for (const recipe of RECIPES) {
        expect(recipeText(RecipeRootOps.flowFileOf(recipe))).not.toMatch(
          /\b(Implement\.trigger|Review\.(trigger|reReviewTrigger|addressTrigger))\b/,
        );
      }
    }),
  );
});

describe("installing recipes", () => {
  effect("writes the flow and the prompts it renders", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* checkout;
      const lines = yield* bake(repo, "implement");
      expect(lines).toEqual([
        "wrote .chernabog/flows/implement.ts (implement recipe)",
        "wrote .chernabog/prompts/implement.md (implement recipe)",
      ]);
      expect(yield* fs.readFileString(`${repo}/.chernabog/flows/implement.ts`)).toBe(
        recipeText("flows/implement.ts"),
      );
      expect(yield* installed(repo)).toEqual(["implement"]);
    }),
  );

  effect("resolve-conflicts writes its flow and its prompt", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* checkout;
      expect(yield* bake(repo, "resolve-conflicts")).toEqual([
        "wrote .chernabog/flows/resolve-conflicts.ts (resolve-conflicts recipe)",
        "wrote .chernabog/prompts/resolve-conflicts.md (resolve-conflicts recipe)",
      ]);
      expect(yield* fs.readFileString(`${repo}/.chernabog/prompts/resolve-conflicts.md`)).toBe(
        recipeText("prompts/resolve-conflicts.md"),
      );
      expect(yield* installed(repo)).toEqual(["resolve-conflicts"]);
    }),
  );

  effect("never overwrites a flow the repo has, nor a prompt another recipe brought", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* checkout;
      yield* fs.makeDirectory(`${repo}/.chernabog/flows`, { recursive: true });
      yield* fs.writeFileString(`${repo}/.chernabog/flows/review.ts`, "// ours\n");
      const lines = yield* bake(repo, "review", "re-review");
      expect(lines).toEqual([
        "kept .chernabog/flows/review.ts, which is already there",
        "wrote .chernabog/prompts/review.md (review recipe)",
        "wrote .chernabog/flows/re-review.ts (re-review recipe)",
      ]);
      expect(yield* fs.readFileString(`${repo}/.chernabog/flows/review.ts`)).toBe("// ours\n");
    }),
  );

  effect("refuses a recipe that does not exist, naming the ones that do", () =>
    Effect.gen(function* () {
      const found = yield* Effect.flip(bake(yield* checkout, "implement", "ship"));
      expect(found.message).toBe(
        "no recipe named ship (there are: implement, review, re-review, address-review, resolve-conflicts, human-initiated)",
      );
    }),
  );
});

describe("choosing recipes", () => {
  effect("bakes the ones named, each once, without asking", () =>
    Effect.gen(function* () {
      const answers = scripted([]);

      const lines = yield* baking(
        answers.layer,
        yield* checkout,
        Option.some(["review", "implement", "review"]),
      );

      expect(lines.filter((line) => line.includes("/flows/"))).toEqual([
        "wrote .chernabog/flows/review.ts (review recipe)",
        "wrote .chernabog/flows/implement.ts (implement recipe)",
      ]);
      expect(answers.asked).toEqual([]);
    }),
  );

  effect("bakes none with no one to ask", () =>
    Effect.gen(function* () {
      expect(yield* baking(Asker.none, yield* checkout, Option.none())).toEqual([]);
    }),
  );

  effect(
    "in a terminal, offers the ones the repo lacks, each with its description and docs, none picked",
    () =>
      Effect.gen(function* () {
        const repo = yield* checkout;
        yield* bake(repo, "implement");
        const answers = scripted([["human-initiated"]]);
        yield* baking(answers.layer, repo, Option.none());

        expect(yield* installed(repo)).toEqual(["implement", "human-initiated"]);
        const offered = answers.asked[0]?.choices ?? [];
        expect(offered.map((choice) => choice.value)).toEqual([
          "review",
          "re-review",
          "address-review",
          "resolve-conflicts",
          "human-initiated",
        ]);
        expect(offered.some((choice) => choice.selected === true)).toBe(false);
        expect(offered[4]?.description).toContain(
          "https://dataquail.github.io/chernabog/recipes/human-initiated/",
        );
      }),
  );

  effect("asks nothing once the repo has every recipe", () =>
    Effect.gen(function* () {
      const repo = yield* checkout;
      yield* bake(repo, ...RECIPES.map((recipe) => recipe.name));
      const answers = scripted([]);

      expect(yield* baking(answers.layer, repo, Option.none())).toEqual([]);
      expect(answers.asked).toEqual([]);
    }),
  );
});

describe("the implement recipe's trigger", () => {
  effect(
    "queues auto:eligible issues, then auto:ship ones, saying so for claim and openPullRequest",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve");
        fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
        expect((yield* flowTriggered(fake, implement)).map((work) => work.data)).toEqual([
          { issue: ISSUE },
        ]);
        fake.setLabels(ISSUE, [DEFAULT_LABELS.ship]);
        expect((yield* flowTriggered(fake, implement)).map((work) => work.data)).toEqual([
          { issue: ISSUE, label: DEFAULT_LABELS.ship },
        ]);
        fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible, DEFAULT_LABELS.ship]);
        expect((yield* flowTriggered(fake, implement)).map((work) => work.data)).toEqual([
          { issue: ISSUE },
        ]);
        fake.setLabels(ISSUE, []);
        expect(yield* flowTriggered(fake, implement)).toEqual([]);
      }),
  );
});

const diffing = (repo: string, names: ReadonlyArray<string>) =>
  diffLines(repo, names).pipe(Effect.provide(recipes(Asker.none)));

describe("diffing against the recipes", () => {
  // A repo that baked review and re-review, edited review's flow, and has a flow of its own.
  const baked = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repo = yield* checkout;
    yield* bake(repo, "review", "re-review");
    yield* fs.writeFileString(
      `${repo}/.chernabog/flows/review.ts`,
      recipeText("flows/review.ts").replace("concurrency: 1,", "concurrency: 2,"),
    );
    yield* fs.writeFileString(`${repo}/.chernabog/flows/security.ts`, "export default {};\n");

    return repo;
  });

  effect(
    "shows each of the repo's flows against the recipe it came from, and the flows from none",
    () =>
      Effect.gen(function* () {
        const lines = yield* diffing(yield* baked, []);
        expect(lines[0]).toBe(
          ".chernabog/flows/review.ts: differs from the review recipe (https://dataquail.github.io/chernabog/recipes/review/)",
        );
        expect(lines[1]).toContain(
          "--- recipe/.chernabog/flows/review.ts\n+++ repo/.chernabog/flows/review.ts",
        );
        expect(lines[1]).toContain("-  concurrency: 1,\n+  concurrency: 2,");
        expect(lines.slice(2)).toEqual([
          ".chernabog/prompts/review.md: the same as the review recipe",
          ".chernabog/flows/re-review.ts: the same as the re-review recipe",
          ".chernabog/prompts/review.md: the same as the re-review recipe",
          ".chernabog/flows/security.ts: from no recipe",
        ]);
      }),
  );

  effect("with names, only those recipes, including one the repo lacks", () =>
    Effect.gen(function* () {
      const lines = yield* diffing(yield* baked, ["re-review", "implement"]);
      expect(lines).toEqual([
        ".chernabog/flows/re-review.ts: the same as the re-review recipe",
        ".chernabog/prompts/review.md: the same as the re-review recipe",
        ".chernabog/flows/implement.ts: not in the repo; chernabog recipes add implement bakes it",
        ".chernabog/prompts/implement.md: not in the repo; chernabog recipes add implement bakes it",
      ]);
    }),
  );

  effect("says when the repo has no flows", () =>
    Effect.gen(function* () {
      expect(yield* diffing(yield* checkout, [])).toEqual([
        ".chernabog/flows/ has no flows; chernabog recipes list shows the recipes",
      ]);
    }),
  );
});
