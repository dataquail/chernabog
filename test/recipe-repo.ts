// A checkout in memory for the recipes module's use-cases, with a fake
// registry: @chernabog/recipes at 0.1.0 and 0.2.0 for SDK 0.6, and 0.9.0 for
// a newer SDK, and @acme/recipes, a company's own package.

import { type Json, printJson } from "@chernabog/sdk";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";

import { decodeRepoManifest } from "../src/modules/recipes/domain/recipe/repo-manifest.value-object.ts";
import { BundleClientFake } from "../src/modules/recipes/infrastructure/clients/bundle.client-fake.ts";
import { ChernabogDirClientFake } from "../src/modules/recipes/infrastructure/clients/chernabog-dir.client-fake.ts";
import {
  type FakeRegistry,
  type FakeRelease,
  RecipePackagesClientFake,
} from "../src/modules/recipes/infrastructure/clients/recipe-packages.client-fake.ts";
import { TextDiffClientFake } from "../src/modules/recipes/infrastructure/clients/text-diff.client-fake.ts";
import { FlowImportsRepositoryFake } from "../src/modules/recipes/infrastructure/repositories/flow-imports.repository-fake.ts";

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
  // config.yaml's flows.<name>.from, by `/repo/<name>`.
  const imports = new Map(
    Object.entries(imported).map(([flow, from]) => [`/repo/${flow}`, from] as const),
  );

  const stored: Record<string, string> = Object.fromEntries(
    Object.entries({
      ".chernabog/package.json": manifestWith({ "@chernabog/recipes": "0.1.0" }),
      ...files,
    }).map(([path, text]) => [`/repo/${path}`, text]),
  );

  return {
    stored,
    imports,
    layer: Layer.mergeAll(
      FlowImportsRepositoryFake(imports),
      ChernabogDirClientFake(stored),
      BundleClientFake(SCAFFOLD),
      RecipePackagesClientFake(REGISTRY, stored, offline),
      TextDiffClientFake,
    ),
  };
};
