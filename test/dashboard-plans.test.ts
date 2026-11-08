// The dashboard's tests draw real documents' plans, but a dashboard file names
// only effect, React and the daemon's protocol, so it can't compile one. They
// read packages/dashboard/src/document-plans.ts instead, which this test holds
// to what Compose.plan compiles the review, implement and epic documents to.

import { printJson } from "@chernabog/core";
import { Compose } from "@chernabog/sdk";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  documentOf,
  EPIC_DOCUMENT,
  IMPLEMENT_DOCUMENT,
  REVIEW_DOCUMENT,
} from "./compose-harness.ts";
import { effect } from "./effect-test.ts";

const PLANS = { review: REVIEW_DOCUMENT, implement: IMPLEMENT_DOCUMENT, epic: EPIC_DOCUMENT };

// The file's text: each document's plan, a line each.
const renderDocumentPlans = () =>
  [
    "// Generated: the review, implement and epic documents' plans, as Compose.plan",
    "// compiles them, for the dashboard's tests to draw. test/dashboard-plans.test.ts",
    "// holds this file to it; when it fails, write what it expects here.",
    "export const DOCUMENT_PLANS = {",
    ...Object.entries(PLANS).map(
      ([name, source]) => `  ${name}: ${printJson(Compose.plan(documentOf(source)))},`,
    ),
    "};",
    "",
  ].join("\n");

effect(
  "packages/dashboard/src/document-plans.ts is the review, implement and epic documents' plans, as Compose.plan compiles them",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const written = yield* fs.readFileString(
        yield* path.fromFileUrl(
          new URL("../packages/dashboard/src/document-plans.ts", import.meta.url),
        ),
      );

      expect(written).toBe(renderDocumentPlans());
    }),
);
