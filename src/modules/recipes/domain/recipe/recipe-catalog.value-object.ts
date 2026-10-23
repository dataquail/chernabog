// The recipes this chernabog offers, each with a docs page.

import { RecipeRoot } from "./recipe.root.ts";

export const RECIPES_DOCS = "https://dataquail.github.io/chernabog/recipes/";

export const RECIPES: ReadonlyArray<RecipeRoot> = [
  RecipeRoot.make({
    name: "implement",
    description:
      "Implements the oldest auto:eligible or auto:ship issue unattended, and asks a reviewer from the pool once its pull request is green",
    files: ["flows/implement.ts", "prompts/implement.md"],
  }),
  RecipeRoot.make({
    name: "review",
    description:
      "Reviews a pull request whose review is requested of the persona; an approval merges an auto:ship pull request",
    files: ["flows/review.ts", "prompts/review.md"],
  }),
  RecipeRoot.make({
    name: "re-review",
    description:
      "Reviews again when asked, in its own review session; approves, or hands the pull request to a person",
    files: ["flows/re-review.ts", "prompts/review.md"],
  }),
  RecipeRoot.make({
    name: "address-review",
    description:
      "Answers a review that requests changes on the persona's own pull request, in the session that wrote it",
    files: ["flows/address-review.ts"],
  }),
  RecipeRoot.make({
    name: "human-initiated",
    description:
      "The hybrid path: chernabog start <issue> opens a session with a person, then opens the pull request and asks for a review",
    files: ["flows/human-initiated.ts"],
  }),
];
