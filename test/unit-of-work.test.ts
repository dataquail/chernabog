// Every command declares its unit of work (docs/adr/0009-commands-declare-their-unit-of-work.md):
// what it writes commits together, and what it dispatches is delivered once it has.

import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { effect } from "./effect-test.ts";

describe("command handlers", () => {
  effect("each declares withUnitOfWork", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const modules = yield* path.fromFileUrl(new URL("../src/modules", import.meta.url));
      const handlers: Array<string> = [];

      for (const module of yield* fs.readDirectory(modules)) {
        const commands = path.join(modules, module, "commands");

        if (!(yield* fs.exists(commands))) {
          continue;
        }

        for (const file of yield* fs.readDirectory(commands)) {
          if (file.endsWith(".handler.ts")) {
            handlers.push(path.join(commands, file));
          }
        }
      }

      const undeclared: Array<string> = [];

      for (const handler of handlers) {
        if (!(yield* fs.readFileString(handler)).includes("withUnitOfWork")) {
          undeclared.push(path.relative(modules, handler));
        }
      }

      expect(handlers.length).toBeGreaterThan(40);
      expect(undeclared.sort()).toEqual([]);
    }),
  );
});
