// Runs the recipes' own test suites on what their documents compile to:
// `bun run test:composed` loads this first, so a suite's import of a recipe gets
// the document's flow. Only for epic, implement and review, which have documents.

import { Compose } from "@chernabog/sdk";
import * as Result from "effect/Result";

import {
  documentOf,
  EPIC_DOCUMENT,
  IMPLEMENT_DOCUMENT,
  REVIEW_DOCUMENT,
} from "./compose-harness.ts";

const DOCUMENTS = {
  epic: EPIC_DOCUMENT,
  implement: IMPLEMENT_DOCUMENT,
  review: REVIEW_DOCUMENT,
};

const PATTERN = /packages\/recipes\/flows\/(epic|implement|review)\.ts$/;

const nameOf = (path: string) => {
  const name = PATTERN.exec(path)?.[1];

  if (name === "epic" || name === "implement" || name === "review") {
    return name;
  }

  return "review";
};

Bun.plugin({
  name: "composed-recipes",
  setup(build) {
    build.onLoad({ filter: PATTERN }, ({ path }) => ({
      contents: `${Result.getOrThrow(Compose.generate(documentOf(DOCUMENTS[nameOf(path)])))}\nexport const composedFromDocument = true;\n`,
      loader: "ts",
    }));
  },
});
