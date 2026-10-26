// Writes src/platform/templates.ts: every file under templates/.chernabog/, as the text
// `chernabog init` scaffolds, and the flows and prompts of packages/recipes/, as
// the recipes bake. They stay real files, so the flows among them are
// type-checked against the SDK.
// Run after changing a template: bun scripts/gen-templates.ts

import { fileURLToPath } from "node:url";

import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { renderTemplates, templatesRoot } from "./templates.ts";

const output = fileURLToPath(new URL("../src/platform/templates.ts", import.meta.url));

const program = Effect.gen(function* () {
  const { count, text } = yield* renderTemplates(templatesRoot);
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(output, text);
  yield* Console.log(`${count} templates`);
});

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));
