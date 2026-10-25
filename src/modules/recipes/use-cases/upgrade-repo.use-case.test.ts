import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { BundleClientFake } from "../infrastructure/clients/bundle.client-fake.ts";
import { ChernabogDirClientFake } from "../infrastructure/clients/chernabog-dir.client-fake.ts";
import { TextDiffClientFake } from "../infrastructure/clients/text-diff.client-fake.ts";
import { upgradeRepoUseCase } from "./upgrade-repo.use-case.ts";

const SCAFFOLD = {
  files: { "config.yaml": "flows: {}\n" },
  generated: [],
  manifest: '{ "pinned" }\n',
};

// A checkout at /repo holding `files`, by path under it.
const repoWith = (files: Record<string, string>) => {
  const stored: Record<string, string> = Object.fromEntries(
    Object.entries(files).map(([path, text]) => [`/repo/${path}`, text]),
  );

  return {
    stored,
    layer: Layer.mergeAll(
      ChernabogDirClientFake(stored),
      BundleClientFake(SCAFFOLD),
      TextDiffClientFake,
    ),
  };
};

describe("upgradeRepoUseCase", () => {
  const old = repoWith({
    ".chernabog/package.json": '{ "old" }\n',
    ".chernabog/flows/review.ts": "old review\n",
    ".chernabog/flows/re-review.ts": "recipe of flows/re-review.ts\n",
    ".chernabog/flows/security.ts": 'import { gone } from "@chernabog/sdk";\n',
    ".chernabog/stages/lint.ts": "fine\n",
  });

  effect("moves the pins and the recipes' flows and prompts, and lists what's hand-written", () =>
    Effect.gen(function* () {
      const { changes, left } = yield* upgradeRepoUseCase("/repo");

      expect(changes.map((change) => [change.file, change.change])).toEqual([
        [".chernabog/package.json", "pinned"],
        [".chernabog/flows/review.ts", "replaced"],
        [".chernabog/prompts/review.md", "written"],
      ]);
      expect(changes[1].recipe).toEqual(Option.some("review"));
      expect(old.stored["/repo/.chernabog/flows/review.ts"]).toBe("recipe of flows/review.ts\n");
      expect(old.stored["/repo/.chernabog/package.json"]).toBe('{ "old" }\n"pinned"\n');
      expect(left).toEqual([
        { file: ".chernabog/flows/security.ts", missingImports: ["gone"] },
        { file: ".chernabog/stages/lint.ts", missingImports: [] },
      ]);
    }).pipe(Effect.provide(old.layer)),
  );

  const current = repoWith({
    ".chernabog/package.json": '{ "pinned" }\n',
    ".chernabog/flows/implement.ts": "recipe of flows/implement.ts\n",
    ".chernabog/prompts/implement.md": "recipe of prompts/implement.md\n",
  });

  effect("changes nothing in a repo already on this chernabog", () =>
    Effect.gen(function* () {
      const { changes, left } = yield* upgradeRepoUseCase("/repo");

      expect([changes, left]).toEqual([[], []]);
    }).pipe(Effect.provide(current.layer)),
  );

  const bare = repoWith({ ".chernabog/flows/implement.ts": "recipe of flows/implement.ts\n" });

  effect("writes package.json where there's none", () =>
    Effect.gen(function* () {
      const { changes } = yield* upgradeRepoUseCase("/repo");

      expect(changes[0]).toEqual({
        file: ".chernabog/package.json",
        recipe: Option.none(),
        change: "pinned",
      });
      expect(bare.stored["/repo/.chernabog/package.json"]).toBe('{ "pinned" }\n');
    }).pipe(Effect.provide(bare.layer)),
  );

  const tooNew = repoWith({
    ".chernabog/package.json": '{ "too new" }\n',
    ".chernabog/flows/review.ts": "newer review\n",
  });

  effect("refuses a .chernabog/ written against a newer SDK, writing nothing", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(upgradeRepoUseCase("/repo"));

      expect(refused._tag).toBe("ScaffoldRefused");
      expect(tooNew.stored["/repo/.chernabog/flows/review.ts"]).toBe("newer review\n");
    }).pipe(Effect.provide(tooNew.layer)),
  );
});
