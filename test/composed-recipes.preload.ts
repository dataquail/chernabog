// Runs the recipes' own test suites on what their documents compile to:
// `bun run test:composed` loads this first, so a suite's import of a recipe gets
// the document's flow. Only for epic, implement, review, re-review,
// address-review, resolve-conflicts and post-merge, which have documents.

import { Compose } from "@chernabog/sdk";
import * as Result from "effect/Result";

import {
  ADDRESS_REVIEW_DOCUMENT,
  documentOf,
  EPIC_DOCUMENT,
  IMPLEMENT_DOCUMENT,
  POST_MERGE_DOCUMENT,
  RE_REVIEW_DOCUMENT,
  RESOLVE_CONFLICTS_DOCUMENT,
  REVIEW_DOCUMENT,
} from "./compose-harness.ts";

const DOCUMENTS = {
  epic: EPIC_DOCUMENT,
  implement: IMPLEMENT_DOCUMENT,
  review: REVIEW_DOCUMENT,
  "re-review": RE_REVIEW_DOCUMENT,
  "address-review": ADDRESS_REVIEW_DOCUMENT,
  "resolve-conflicts": RESOLVE_CONFLICTS_DOCUMENT,
  "post-merge": POST_MERGE_DOCUMENT,
};

const PATTERN =
  /packages\/recipes\/flows\/(epic|implement|review|re-review|address-review|resolve-conflicts|post-merge)\.ts$/;

const nameOf = (path: string) => {
  const name = PATTERN.exec(path)?.[1];

  if (
    name === "epic" ||
    name === "implement" ||
    name === "review" ||
    name === "re-review" ||
    name === "address-review" ||
    name === "resolve-conflicts" ||
    name === "post-merge"
  ) {
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
