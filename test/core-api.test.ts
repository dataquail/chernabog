import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { coreApiFile, renderCoreApi } from "../scripts/core-api.ts";
import { effect } from "./effect-test.ts";

// Core only grows within a major (docs/adr/0004-core-abi.md): its declarations
// are committed, so a change to them is a diff a reviewer reads.
effect(
  "packages/core/API.md is what scripts/gen-core-api.ts writes from core (run it after changing core, and review the diff)",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      expect(yield* fs.readFileString(coreApiFile)).toBe(yield* renderCoreApi);
    }),
);
