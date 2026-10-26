// Prompts are looked up in layers: the repo's prompts/<name>.md, then, for a
// flow imported from a recipe package, the package's, then the SDK's default.

import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { renderPrompt, renderPromptOr } from "../packages/sdk/src/prompt.ts";
import { FlowPackage, Repo } from "../packages/sdk/src/services.ts";
import { effect } from "./effect-test.ts";
import { settings } from "./sdk-fakes.ts";

// A repo's .chernabog/ and an installed package, each with these prompts.
const layers = (repo: Readonly<Record<string, string>>, pkg: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-prompts-" });

    for (const [dir, prompts] of [
      ["repo", repo],
      ["package", pkg],
    ] as const) {
      yield* fs.makeDirectory(`${root}/${dir}/prompts`, { recursive: true });

      for (const [name, text] of Object.entries(prompts)) {
        yield* fs.writeFileString(`${root}/${dir}/prompts/${name}.md`, text);
      }
    }

    return root;
  });

const rendering = <A, E, R>(root: string, imported: boolean, render: Effect.Effect<A, E, R>) => {
  const inRepo = Effect.provideService(render, Repo, { ...settings, configDir: `${root}/repo` });

  if (!imported) {
    return inRepo;
  }

  return Effect.provideService(inRepo, FlowPackage, {
    name: "@acme/recipes",
    version: "1.0.0",
    dir: `${root}/package`,
  });
};

describe("rendering a prompt for an imported flow", () => {
  effect("takes the repo's prompt over the package's, the package's over the SDK's default", () =>
    Effect.gen(function* () {
      const root = yield* layers(
        { deploy: "repo {{x}}" },
        { deploy: "package", ship: "package {{x}}" },
      );

      expect(yield* rendering(root, true, renderPrompt("deploy", { x: 1 }))).toBe("repo 1");
      expect(yield* rendering(root, true, renderPrompt("ship", { x: 2 }))).toBe("package 2");
      expect(
        yield* rendering(root, true, renderPromptOr("consider", "default {{x}}", { x: 3 })),
      ).toBe("default 3");
      expect(yield* rendering(root, true, renderPromptOr("ship", "default", {}))).toBe(
        "package {{x}}",
      );
    }),
  );

  effect("for a flow in the repo, never looks in a package, and says where it looked", () =>
    Effect.gen(function* () {
      const root = yield* layers({}, { ship: "package" });

      const missing = yield* Effect.flip(rendering(root, false, renderPrompt("ship", {})));
      expect(missing.message).toBe(`no prompt at ${root}/repo/prompts/ship.md`);

      const both = yield* Effect.flip(rendering(root, true, renderPrompt("deploy", {})));
      expect(both.message).toBe(
        `no prompt at ${root}/repo/prompts/deploy.md or ${root}/package/prompts/deploy.md`,
      );
    }),
  );
});
