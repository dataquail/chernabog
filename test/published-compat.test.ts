// Old blocks on a new binary: the oldest and the newest @chernabog/sdk on npm
// that need a core this binary provides, each with the newest
// @chernabog/recipes for it, installed from the registry and loaded under this
// checkout's core, every recipe imported. A change to core that breaks a
// published SDK, such as a port's signature or an export gone, fails here
// before it ships (docs/adr/0004-core-abi.md). It reads npm, so it runs only
// where CHERNABOG_PUBLISHED=true: CI's compat job.

import { BunServices } from "@effect/platform-bun";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { printJson } from "../packages/core/src/json.ts";
import { coreSupport } from "../src/kernel/core-support.value-object.ts";
import { RecipePackageManifest } from "../src/kernel/recipe-package.value-object.ts";
import { Exec, execOk } from "../src/platform/exec.ts";
import { checkInstalled } from "../src/platform/flow-deps.ts";
import { loadFlows } from "../src/platform/flow-loader.ts";
import { bunExecutable } from "../src/platform/self.ts";
import { effectAtHomeWith } from "./effect-test.ts";

const effect = effectAtHomeWith(Exec.layer.pipe(Layer.provide(BunServices.layer)));

const Versions = Schema.fromJsonString(Schema.Array(Schema.String));
const Peers = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

const bun = (args: ReadonlyArray<string>, cwd?: string) => execOk(bunExecutable(), args, { cwd });

// A package's released versions, oldest first, without prereleases.
const released = (name: string) =>
  bun(["info", name, "versions", "--json"]).pipe(
    Effect.flatMap(Schema.decodeEffect(Versions)),
    Effect.map((versions) =>
      versions
        .filter((version) => !version.includes("-"))
        .toSorted((left, right) => Bun.semver.order(left, right)),
    ),
  );

// What a version of a package declares of `peer`; none when it declares nothing.
const peerRange = (name: string, version: string, peer: string) =>
  bun(["info", `${name}@${version}`, "peerDependencies", "--json"]).pipe(
    Effect.map((text) =>
      Option.flatMap(Schema.decodeOption(Peers)(text.trim()), (peers) =>
        Option.fromUndefinedOr(peers[peer]),
      ),
    ),
  );

// Every released SDK whose range of core this binary provides.
const claimedSdks = Effect.gen(function* () {
  const claimed: Array<string> = [];

  for (const version of yield* released("@chernabog/sdk")) {
    const range = yield* peerRange("@chernabog/sdk", version, "@chernabog/core");

    if (Option.exists(range, (found) => coreSupport(found) === "supported")) {
      claimed.push(version);
    }
  }

  return claimed;
});

// The newest released @chernabog/recipes whose SDK range includes `sdk`.
const recipesFor = (sdk: string) =>
  Effect.gen(function* () {
    for (const version of (yield* released("@chernabog/recipes")).toReversed()) {
      const range = yield* peerRange("@chernabog/recipes", version, "@chernabog/sdk");

      if (Option.exists(range, (found) => Bun.semver.satisfies(sdk, found))) {
        return Option.some(version);
      }
    }

    return Option.none<string>();
  });

// A .chernabog/ on `sdk`, importing every recipe of `recipes`, installed and loaded.
const loadPublished = (sdk: string, recipes: Option.Option<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-published-" });

    yield* fs.writeFileString(
      `${dir}/package.json`,
      printJson({
        private: true,
        dependencies: {
          "@chernabog/sdk": sdk,
          ...Option.match(recipes, {
            onNone: () => ({}),
            onSome: (version) => ({ "@chernabog/recipes": version }),
          }),
        },
      }),
    );

    yield* bun(["install", "--ignore-scripts"], dir);

    const names = yield* Option.match(recipes, {
      onNone: () => Effect.succeed<ReadonlyArray<string>>([]),
      onSome: () =>
        fs.readFileString(`${dir}/node_modules/@chernabog/recipes/package.json`).pipe(
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(RecipePackageManifest))),
          Effect.map((manifest) => Object.keys(manifest.chernabog.recipes)),
        ),
    });

    yield* fs.writeFileString(
      `${dir}/config.yaml`,
      `flows:\n${names.map((name) => `  ${name}:\n    from: "@chernabog/recipes/${name}"\n`).join("")}`,
    );

    yield* checkInstalled(dir);
    const flows = yield* loadFlows(dir);

    expect([...flows.keys()].toSorted()).toEqual([...names].toSorted());
  });

describe("the published SDKs this binary claims to run", () => {
  effect(
    "the oldest and the newest load, with every recipe of theirs, under this core",
    () =>
      Effect.gen(function* () {
        if (!(yield* Config.Boolean("CHERNABOG_PUBLISHED").pipe(Config.withDefault(false)))) {
          return yield* Console.log(
            "CHERNABOG_PUBLISHED isn't set; the published SDKs aren't read",
          );
        }

        const claimed = yield* claimedSdks;

        if (!Arr.isArrayNonEmpty(claimed)) {
          return yield* Console.log(
            "no published @chernabog/sdk needs a core this binary provides yet; nothing to check",
          );
        }

        for (const sdk of Arr.dedupe([Arr.headNonEmpty(claimed), Arr.lastNonEmpty(claimed)])) {
          yield* Console.log(`@chernabog/sdk ${sdk}`);
          yield* loadPublished(sdk, yield* recipesFor(sdk));
        }
      }),
    180_000,
  );
});
