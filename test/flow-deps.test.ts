import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { parseJson } from "../packages/core/src/json.ts";
import SdkPackage from "../packages/sdk/package.json" with { type: "json" };
import {
  BUNDLED_CORE_VERSION,
  coreSupport,
  resumesRunsFrom,
} from "../src/kernel/core-support.value-object.ts";
import { Exec, execOk } from "../src/platform/exec.ts";
import {
  BUNDLED_CORE,
  flowPackageText,
  installFlowDependencies,
  missingCoreImports,
  RELEASED_SDK,
} from "../src/platform/flow-deps.ts";
import { bunExecutable } from "../src/platform/self.ts";
import { effectAtHomeWith } from "./effect-test.ts";

const effect = effectAtHomeWith(Exec.layer.pipe(Layer.provide(BunServices.layer)));

// A .chernabog/ whose package.json depends on a package vendored beside it, so installing needs no registry.
const configDirWithDependency = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-deps-" });
  yield* fs.makeDirectory(`${dir}/vendor/greet`, { recursive: true });
  yield* fs.writeFileString(
    `${dir}/vendor/greet/package.json`,
    '{ "name": "greet", "version": "1.0.0", "type": "module", "main": "index.js" }',
  );
  yield* fs.writeFileString(
    `${dir}/vendor/greet/index.js`,
    "export const greet = (name) => `hello ${name}`;\n",
  );
  yield* fs.writeFileString(
    `${dir}/package.json`,
    '{ "private": true, "dependencies": { "greet": "file:./vendor/greet" } }',
  );

  return dir;
});

describe("flow dependencies", () => {
  effect("a .chernabog/ without dependencies installs nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-deps-" });
      yield* fs.writeFileString(
        `${dir}/package.json`,
        '{ "private": true, "devDependencies": { "effect": "4.0.5" } }',
      );
      yield* installFlowDependencies(dir);
      expect(yield* fs.exists(`${dir}/node_modules`)).toBe(false);
    }),
  );

  effect("dependencies without a lockfile are refused", () =>
    Effect.gen(function* () {
      const dir = yield* configDirWithDependency;
      const installed = yield* Effect.result(installFlowDependencies(dir));
      expect(Result.isFailure(installed) && installed.failure.message).toContain("no lockfile");
    }),
  );

  effect(
    "dependencies install at the lockfile's versions, and a lockfile out of step with package.json is refused",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* configDirWithDependency;
        yield* execOk(bunExecutable(), ["install"], { cwd: dir });
        yield* fs.remove(`${dir}/node_modules`, { recursive: true });

        yield* installFlowDependencies(dir);
        expect(yield* fs.exists(`${dir}/node_modules/greet/index.js`)).toBe(true);

        yield* fs.writeFileString(
          `${dir}/package.json`,
          '{ "private": true, "dependencies": { "greet": "file:./vendor/greet", "other": "file:./vendor/greet" } }',
        );
        const installed = yield* Effect.result(installFlowDependencies(dir));
        expect(Result.isFailure(installed) && installed.failure.message).toContain("failed");
      }),
  );
});

describe("the core this binary bundles", () => {
  test("is one it provides, and resumes runs from", () => {
    expect(coreSupport(`^${BUNDLED_CORE}`)).toBe("supported");
    expect(resumesRunsFrom(BUNDLED_CORE)).toBe(true);
  });

  test("is the version the kernel declares, which release-please moves with it", () => {
    expect(BUNDLED_CORE_VERSION).toBe(BUNDLED_CORE);
  });

  test("is one the SDK released with it supports", () => {
    expect(Bun.semver.satisfies(BUNDLED_CORE, SdkPackage.peerDependencies["@chernabog/core"])).toBe(
      true,
    );
    expect(RELEASED_SDK).toBe(SdkPackage.version);
  });

  test("a new .chernabog/ lists the released SDK, and pins core and effect for types", () => {
    expect(Option.getOrThrow(parseJson(flowPackageText()))).toMatchObject({
      dependencies: { "@chernabog/sdk": RELEASED_SDK },
      devDependencies: { "@chernabog/core": BUNDLED_CORE },
    });
  });

  test("a flow's imports of it are checked by name, through namespaces too", () => {
    expect(
      missingCoreImports(
        'import * as C from "@chernabog/core";\nC.defineFlow; C.Claims.releasing; C.Claims.vanished; C.vanished;\n',
      ),
    ).toEqual(["Claims.vanished", "vanished"]);
    expect(
      missingCoreImports(
        'import { Claims as K, type Flow, Skip } from "@chernabog/core";\nK.gone; Skip;\n',
      ),
    ).toEqual(["Claims.gone"]);
    expect(missingCoreImports('import core from "@chernabog/core";\n')).toEqual(["default"]);
    expect(missingCoreImports('import type { Gone } from "@chernabog/core";\n')).toEqual([]);
    // What a flow imports from the SDK is the installed SDK's business.
    expect(missingCoreImports('import { Vanished } from "@chernabog/sdk";\n')).toEqual([]);
  });
});
