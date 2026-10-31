import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { effect } from "./effect-test.ts";

// Each module wires itself in its <module>.module.ts (ADR 9): the roots merge
// the modules, and no module hands them a layer of loose adapters to order.
describe("a module's wiring", () => {
  effect("each module assembles itself in its module.ts, with no layer.ts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL("../src/modules", import.meta.url));
      const modules = yield* fs.readDirectory(root);

      for (const module of modules) {
        const files = yield* fs.readDirectory(path.join(root, module));

        expect(files).toContain(`${module}.module.ts`);
        expect(files.filter((file) => file.endsWith(".layer.ts"))).toEqual([]);
      }
    }),
  );
});
