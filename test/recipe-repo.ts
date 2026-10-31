// A checkout in memory for the recipes module's use-cases, with a fake
// registry: @chernabog/recipes at 0.1.0 and 0.2.0 for SDK 0.6, and 0.9.0 for
// a newer SDK, and @acme/recipes, a company's own package.

import { type Json, printJson } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";

import { FlowImportRoot } from "../src/modules/recipes/domain/flow-import/flow-import.root.ts";
import { decodeRepoManifest } from "../src/modules/recipes/domain/recipe/repo-manifest.value-object.ts";
import { BundleClientFake } from "../src/modules/recipes/infrastructure/clients/bundle.client-fake.ts";
import { ChernabogDirClientFake } from "../src/modules/recipes/infrastructure/clients/chernabog-dir.client-fake.ts";
import { ChernabogDirClientLive } from "../src/modules/recipes/infrastructure/clients/chernabog-dir.client-live.ts";
import {
  type FakeRegistry,
  type FakeRelease,
  RecipePackagesClientFake,
} from "../src/modules/recipes/infrastructure/clients/recipe-packages.client-fake.ts";
import { TextDiffClientFake } from "../src/modules/recipes/infrastructure/clients/text-diff.client-fake.ts";
import { FlowImportsRepositoryFake } from "../src/modules/recipes/infrastructure/repositories/flow-imports.repository-fake.ts";
import { FlowImportsRepositoryLive } from "../src/modules/recipes/infrastructure/repositories/flow-imports.repository-live.ts";

export const SCAFFOLD = {
  files: { "config.yaml": "flows: {}\n", "config.schema.json": "{ schema }\n" },
  generated: ["config.schema.json"],
  manifest: '{ "pinned" }\n',
};

const official = (sdkRange: string, edit: string): FakeRelease => ({
  sdkRange,
  recipes: {
    implement: {
      description: "Implements",
      flow: "flows/implement.ts",
      prompts: ["prompts/implement.md"],
      docs: "https://docs/implement/",
    },
    review: { description: "Reviews", flow: "flows/review.ts", prompts: ["prompts/review.md"] },
    "re-review": {
      description: "Reviews again",
      flow: "flows/re-review.ts",
      prompts: ["prompts/review.md"],
    },
  },
  files: {
    "flows/implement.ts": `implement\nconcurrency 1\n${edit}`,
    "prompts/implement.md": "implement prompt\n",
    "flows/review.ts": `review\n${edit}`,
    "prompts/review.md": "review prompt\n",
    "flows/re-review.ts": "re-review\n",
  },
});

export const REGISTRY: FakeRegistry = {
  "@chernabog/recipes": {
    "0.1.0": official("^0.6.0", ""),
    "0.2.0": official("^0.6.0", "upstream fix\n"),
    "0.9.0": official("^0.9.0", "for 0.9\n"),
  },
  "@acme/recipes": {
    "1.0.0": {
      sdkRange: "^0.6.0",
      recipes: { deploy: { description: "Deploys", flow: "flows/deploy.ts" } },
      files: { "flows/deploy.ts": "deploy\n" },
    },
  },
};

// A package.json's text.
export const jsonText = (value: Json) => `${printJson(value)}\n`;

// A manifest declaring these packages, at these versions, as dev dependencies.
export const manifestWith = (devDependencies: Readonly<Record<string, string>>) =>
  `${printJson({ private: true, devDependencies: { "@chernabog/sdk": "0.6.0", ...devDependencies } })}\n`;

// The .chernabog/package.json a checkout holds now.
export const manifestOf = (stored: Readonly<Record<string, string>>) =>
  Result.getOrThrow(
    decodeRepoManifest(
      Option.getOrElse(Record.get(stored, "/repo/.chernabog/package.json"), () => "{}"),
    ),
  );

// A checkout at /repo holding `files`, by path under it, with @chernabog/recipes
// 0.1.0 installed unless the files give a package.json of their own.
export const recipeRepo = (
  files: Record<string, string>,
  offline = false,
  imported: Readonly<Record<string, string>> = {},
) => {
  // config.yaml's flows.<name>.from.
  const imports = Object.entries(imported).map(([flow, from]) =>
    FlowImportRoot.make({ root: "/repo", flow, from }),
  );

  const stored: Record<string, string> = Object.fromEntries(
    Object.entries({
      ".chernabog/package.json": manifestWith({ "@chernabog/recipes": "0.1.0" }),
      ...files,
    }).map(([path, text]) => [`/repo/${path}`, text]),
  );

  return {
    stored,
    layer: Layer.mergeAll(
      FlowImportsRepositoryFake(imports),
      ChernabogDirClientFake(stored),
      BundleClientFake(SCAFFOLD),
      RecipePackagesClientFake(REGISTRY, stored, offline),
      TextDiffClientFake,
    ),
  };
};

// Scratch checkouts on disk, read with the live directory client and flow
// imports: `checkout` writes one holding `files`, by path under it, with
// @chernabog/recipes 0.1.0 installed unless the files give a package.json of
// their own, and answers its root. The registry stays the fake one above,
// since a test reaches no npm; it reads each checkout's package.json as it was
// written. A test that diffs provides the differ itself.
export const scratchRecipeRepos = () => {
  const stored: Record<string, string> = {};

  const checkout = (files: Record<string, string>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-recipes-" });

      for (const [path, text] of Object.entries({
        ".chernabog/package.json": manifestWith({ "@chernabog/recipes": "0.1.0" }),
        ...files,
      })) {
        yield* fs.makeDirectory(`${root}/${path.slice(0, path.lastIndexOf("/"))}`, {
          recursive: true,
        });
        yield* fs.writeFileString(`${root}/${path}`, text);
        stored[`${root}/${path}`] = text;
      }

      return root;
    });

  return {
    checkout,
    layer: Layer.mergeAll(
      ChernabogDirClientLive,
      FlowImportsRepositoryLive,
      RecipePackagesClientFake(REGISTRY, stored),
    ),
  };
};
