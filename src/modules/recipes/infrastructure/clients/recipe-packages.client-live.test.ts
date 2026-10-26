import { type Json, printJson } from "@chernabog/sdk";
import { BunServices } from "@effect/platform-bun";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effectAtHomeWith } from "../../../../../test/effect-test.ts";
import { Exec } from "../../../../platform/exec.ts";
import { RecipePackagesClient } from "../../domain/ports/clients/recipe-packages.client.ts";
import { RecipePackagesClientLive } from "./recipe-packages.client-live.ts";

// bun would run for real, but nothing here needs the registry: what's
// installed is written into node_modules by hand. The acceptance tests
// install from a registry.
const effect = effectAtHomeWith(Exec.layer.pipe(Layer.provide(BunServices.layer)));

const ACME = {
  name: "@acme/recipes",
  version: "1.2.0",
  peerDependencies: { "@chernabog/sdk": "^0.6.0" },
  chernabog: {
    recipes: { deploy: { description: "Deploys", flow: "flows/deploy.ts" } },
  },
};

// A checkout whose .chernabog/ declares these packages, with each installed.
const checkout = (installed: Readonly<Record<string, Json>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-packages-" });

    const write = (path: string, text: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(`${root}/${path.slice(0, path.lastIndexOf("/"))}`, {
          recursive: true,
        });
        yield* fs.writeFileString(`${root}/${path}`, text);
      });

    yield* write(
      ".chernabog/package.json",
      printJson({
        devDependencies: Object.fromEntries(Object.keys(installed).map((name) => [name, "1.2.0"])),
      }),
    );

    for (const [name, manifest] of Object.entries(installed)) {
      yield* write(`.chernabog/node_modules/${name}/package.json`, printJson(manifest));
    }

    yield* write(".chernabog/node_modules/@acme/recipes/flows/deploy.ts", "deploy\n");

    return root;
  });

describe("RecipePackagesClientLive", () => {
  effect("reads the recipe packages installed, leaving out the packages that aren't one", () =>
    Effect.gen(function* () {
      const packages = yield* RecipePackagesClient;

      const root = yield* checkout({
        "@acme/recipes": ACME,
        "@chernabog/sdk": { name: "@chernabog/sdk", version: "0.6.0" },
      });

      yield* packages.restore(root);
      const [found, ...rest] = yield* packages.installed(root);

      expect(rest).toEqual([]);
      expect([found.name, found.version, found.sdkRange]).toEqual([
        "@acme/recipes",
        "1.2.0",
        Option.some("^0.6.0"),
      ]);
      expect(found.recipes.map((recipe) => [recipe.name, recipe.flow])).toEqual([
        ["deploy", "flows/deploy.ts"],
      ]);
      expect(yield* packages.file(root, "@acme/recipes", "flows/deploy.ts")).toEqual(
        Option.some("deploy\n"),
      );
      expect(yield* packages.fileAt(root, "@acme/recipes", "1.2.0", "flows/deploy.ts")).toEqual(
        Option.some("deploy\n"),
      );
    }).pipe(Effect.provide(RecipePackagesClientLive)),
  );

  effect("refuses a package that claims to hold recipes and doesn't describe them", () =>
    Effect.gen(function* () {
      const packages = yield* RecipePackagesClient;

      const root = yield* checkout({
        "@acme/recipes": { ...ACME, chernabog: { recipes: { deploy: { flow: "deploy.ts" } } } },
      });

      const refused = yield* Effect.flip(packages.installed(root));

      expect(refused.message).toContain("@acme/recipes isn't a valid recipe package");
    }).pipe(Effect.provide(RecipePackagesClientLive)),
  );
});
