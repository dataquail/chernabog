import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { jsonText, recipeRepo } from "../../../../test/recipe-repo.ts";
import { upgradeRepoHandler } from "./upgrade-repo.handler.ts";

const OLD = jsonText({
  devDependencies: { "@chernabog/sdk": "0.5.0" },
  chernabog: {
    copied: { "flows/review.ts": { from: "@chernabog/recipes/review", version: "0.0.1" } },
  },
});

describe("upgradeRepoHandler", () => {
  const old = recipeRepo({
    ".chernabog/package.json": OLD,
    ".chernabog/flows/review.ts": "old review\n",
    ".chernabog/flows/security.ts": 'import { gone } from "@chernabog/core";\n',
    ".chernabog/stages/lint.ts": "fine\n",
  });

  effect("moves the pins, and lists what's hand-written, leaving the copies to update", () =>
    Effect.gen(function* () {
      const { left, pinned } = yield* upgradeRepoHandler({ root: "/repo" });

      expect(pinned).toBe(true);
      expect(old.stored["/repo/.chernabog/package.json"]).toBe(`${OLD}"pinned"\n`);
      expect(old.stored["/repo/.chernabog/flows/review.ts"]).toBe("old review\n");
      expect(left).toEqual([
        { file: ".chernabog/flows/security.ts", missingImports: ["gone"] },
        { file: ".chernabog/stages/lint.ts", missingImports: [] },
      ]);
    }).pipe(Effect.provide(old.layer)),
  );

  const current = recipeRepo({
    ".chernabog/package.json": '{ "pinned" }\n',
  });

  effect("changes nothing in a repo already on this chernabog", () =>
    Effect.gen(function* () {
      const { left, pinned } = yield* upgradeRepoHandler({ root: "/repo" });

      expect([pinned, left]).toEqual([false, []]);
    }).pipe(Effect.provide(current.layer)),
  );

  const bare = recipeRepo({});

  effect("writes package.json where there's none", () =>
    Effect.gen(function* () {
      delete bare.stored["/repo/.chernabog/package.json"];
      const { pinned } = yield* upgradeRepoHandler({ root: "/repo" });

      expect(pinned).toBe(true);
      expect(bare.stored["/repo/.chernabog/package.json"]).toBe('{ "pinned" }\n');
    }).pipe(Effect.provide(bare.layer)),
  );

  const tooNew = recipeRepo({
    ".chernabog/package.json": '{ "too new" }\n',
    ".chernabog/flows/review.ts": "newer review\n",
  });

  effect("refuses a .chernabog/ written against a newer SDK, writing nothing", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(upgradeRepoHandler({ root: "/repo" }));

      expect(refused._tag).toBe("ScaffoldRefused");
      expect(tooNew.stored["/repo/.chernabog/flows/review.ts"]).toBe("newer review\n");
    }).pipe(Effect.provide(tooNew.layer)),
  );
});
