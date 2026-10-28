// Writes packages/core/API.md: @chernabog/core's public declarations.
// Run after changing core, and review the diff: bun scripts/gen-core-api.ts

import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { coreApiFile, renderCoreApi } from "./core-api.ts";

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(coreApiFile, yield* renderCoreApi);
  yield* Console.log(`wrote ${coreApiFile}`);
});

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));
