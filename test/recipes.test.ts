// Recipes: what each one bakes into a repo, that baking never overwrites the
// repo's own flows, and how the ones to bake are chosen.

import { DEFAULT_LABELS } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { Asker } from "../src/ask.ts";
import { Exec } from "../src/Exec.ts";
import {
  chooseRecipes,
  diffRecipes,
  docsOf,
  flowFileOf,
  installedRecipes,
  installRecipes,
  type Recipe,
  recipeNamed,
  RECIPES,
} from "../src/recipes.ts";
import { RECIPE_FILES } from "../src/templates.ts";
import implement from "../templates/recipes/flows/implement.ts";
import { scripted } from "./asker.ts";
import { effect } from "./effect-test.ts";
import { flowTriggered, ISSUE, makeFake } from "./sdk-fakes.ts";

const checkout = FileSystem.FileSystem.use((fs) =>
  fs.makeTempDirectoryScoped({ prefix: "chernabog-recipes-" }),
);

// Choosing with these answers: a script of them, or no one to ask.
const choosing = (
  layer: Layer.Layer<Asker>,
  given: Option.Option<ReadonlyArray<string>>,
  installed: ReadonlyArray<Recipe>,
) => chooseRecipes(given, installed).pipe(Effect.provide(layer));

const named = (...names: ReadonlyArray<string>) => Effect.forEach(names, recipeNamed);

describe("the recipes", () => {
  effect("each brings its own flow, named for it, and a docs page", () =>
    Effect.sync(() => {
      for (const recipe of RECIPES) {
        expect<string>(flowFileOf(recipe)).toBe(`flows/${recipe.name}.ts`);
        expect(docsOf(recipe)).toBe(
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
        expect(RECIPE_FILES[flowFileOf(recipe)]).not.toMatch(
          /\b(Implement|Review)\.(workflow|reReviewWorkflow|addressWorkflow)\b/,
        );
      }
    }),
  );

  effect("nor an SDK trigger, whose filters would hide its policy", () =>
    Effect.sync(() => {
      for (const recipe of RECIPES) {
        expect(RECIPE_FILES[flowFileOf(recipe)]).not.toMatch(
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
      const lines = yield* installRecipes(repo, yield* named("implement"));
      expect(lines).toEqual([
        "wrote .chernabog/flows/implement.ts (implement recipe)",
        "wrote .chernabog/prompts/implement.md (implement recipe)",
      ]);
      expect(yield* fs.readFileString(`${repo}/.chernabog/flows/implement.ts`)).toBe(
        RECIPE_FILES["flows/implement.ts"],
      );
      expect((yield* installedRecipes(repo)).map((recipe) => recipe.name)).toEqual(["implement"]);
    }),
  );

  effect("never overwrites a flow the repo has, nor a prompt another recipe brought", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* checkout;
      yield* fs.makeDirectory(`${repo}/.chernabog/flows`, { recursive: true });
      yield* fs.writeFileString(`${repo}/.chernabog/flows/review.ts`, "// ours\n");
      const lines = yield* installRecipes(repo, yield* named("review", "re-review"));
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
      const found = yield* Effect.result(recipeNamed("ship"));
      expect(Result.isFailure(found) && found.failure.message).toBe(
        "no recipe named ship (there are: implement, review, re-review, address-review, human-initiated)",
      );
    }),
  );
});

describe("choosing recipes", () => {
  effect("takes the ones named, without asking", () =>
    Effect.gen(function* () {
      const answers = scripted([]);

      const chosen = yield* choosing(
        answers.layer,
        Option.some(["review", "implement", "review"]),
        [],
      );

      expect(chosen.map((recipe) => recipe.name)).toEqual(["review", "implement"]);
      expect(answers.asked).toEqual([]);
    }),
  );

  effect("chooses none with no one to ask", () =>
    Effect.gen(function* () {
      expect(yield* choosing(Asker.none, Option.none(), [])).toEqual([]);
    }),
  );

  effect(
    "in a terminal, offers the ones the repo lacks, each with its description and docs, none picked",
    () =>
      Effect.gen(function* () {
        const answers = scripted([["human-initiated"]]);
        const chosen = yield* choosing(answers.layer, Option.none(), yield* named("implement"));
        expect(chosen.map((recipe) => recipe.name)).toEqual(["human-initiated"]);
        const offered = answers.asked[0]?.choices ?? [];
        expect(offered.map((choice) => choice.value)).toEqual([
          "review",
          "re-review",
          "address-review",
          "human-initiated",
        ]);
        expect(offered.some((choice) => choice.selected === true)).toBe(false);
        expect(offered[3]?.description).toContain(
          "https://dataquail.github.io/chernabog/recipes/human-initiated/",
        );
      }),
  );

  effect("asks nothing once the repo has every recipe", () =>
    Effect.gen(function* () {
      const answers = scripted([]);
      expect(yield* choosing(answers.layer, Option.none(), RECIPES)).toEqual([]);
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
  diffRecipes(repo, names).pipe(Effect.provide(Exec.layer));

describe("diffing against the recipes", () => {
  // A repo that baked review and re-review, edited review's flow, and has a flow of its own.
  const baked = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repo = yield* checkout;
    yield* installRecipes(repo, yield* named("review", "re-review"));
    yield* fs.writeFileString(
      `${repo}/.chernabog/flows/review.ts`,
      RECIPE_FILES["flows/review.ts"].replace("concurrency: 1,", "concurrency: 2,"),
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
