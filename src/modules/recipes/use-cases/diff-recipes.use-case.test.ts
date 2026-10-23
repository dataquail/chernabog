import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { BundleClientFake } from "../infrastructure/clients/bundle.client-fake.ts";
import { ChernabogDirClientFake } from "../infrastructure/clients/chernabog-dir.client-fake.ts";
import { TextDiffClientFake } from "../infrastructure/clients/text-diff.client-fake.ts";
import { diffRecipesUseCase } from "./diff-recipes.use-case.ts";

const SCAFFOLD = {
  files: { "config.yaml": "flows: {}\n", "config.schema.json": "{ schema }\n" },
  generated: ["config.schema.json"],
  manifest: "{ }\n",
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

describe("diffRecipesUseCase", () => {
  const repo = repoWith({
    ".chernabog/flows/review.ts": "edited\n",
    ".chernabog/prompts/review.md": "recipe of prompts/review.md\n",
    ".chernabog/flows/security.ts": "ours\n",
  });

  effect("sets each of the repo's flows against its recipe, and lists the ones from none", () =>
    Effect.gen(function* () {
      const { files } = yield* diffRecipesUseCase("/repo", []);

      expect(files.map((file) => [file.file, file.state])).toEqual([
        [".chernabog/flows/review.ts", "differs"],
        [".chernabog/prompts/review.md", "same"],
        [".chernabog/flows/security.ts", "unowned"],
      ]);
      expect(files[0].diff).toEqual(
        Option.some("-recipe of flows/review.ts\n+edited (flows/review.ts)"),
      );
    }).pipe(Effect.provide(repo.layer)),
  );

  effect("with names, only those recipes, saying which files the repo lacks", () =>
    Effect.gen(function* () {
      const { files } = yield* diffRecipesUseCase("/repo", ["implement"]);

      expect(files.map((file) => [file.file, file.state])).toEqual([
        [".chernabog/flows/implement.ts", "missing"],
        [".chernabog/prompts/implement.md", "missing"],
      ]);
    }).pipe(Effect.provide(repo.layer)),
  );
});
