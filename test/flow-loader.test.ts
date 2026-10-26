import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { defineFlow, isManual } from "../packages/sdk/src/flow.ts";
import { printJson } from "../packages/sdk/src/json.ts";
import { BUNDLED_SDK, checkFlowImports } from "../src/platform/flow-deps.ts";
import { describeSource, flowNames, flowSourceOf, loadFlows } from "../src/platform/flow-loader.ts";
import { effect } from "./effect-test.ts";

// A .chernabog/ holding one flow module, flows/<name>.ts.
const withFlow = (name: string, source: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-flows-" });
    yield* fs.makeDirectory(`${configDir}/flows`);
    yield* fs.writeFileString(`${configDir}/flows/${name}.ts`, source);

    return configDir;
  });

const load = (name: string, source: string) =>
  Effect.flatMap(withFlow(name, source), loadFlows).pipe(
    Effect.map((flows) => Option.fromUndefinedOr(flows.get(name))),
  );

describe("loading flows", () => {
  effect("a flow with an item lookup and no trigger loads as manual", () =>
    Effect.gen(function* () {
      const flow = yield* load(
        "by-hand",
        `import { defineFlow } from "@chernabog/sdk";
import * as Effect from "effect/Effect";

export default defineFlow({ item: () => Effect.succeedNone, workflow: () => Effect.void });
`,
      );

      expect(Option.map(flow, isManual)).toEqual(Option.some(true));
    }),
  );

  effect("a flow on Hybrid.trigger still loads, and isn't manual", () =>
    Effect.gen(function* () {
      const flow = yield* load(
        "human-initiated",
        `import { defineFlow, Hybrid } from "@chernabog/sdk";
import * as Effect from "effect/Effect";

export default defineFlow({ trigger: Hybrid.trigger, item: Hybrid.itemFor, workflow: () => Effect.void });
`,
      );

      expect(Option.map(flow, isManual)).toEqual(Option.some(false));
    }),
  );

  effect("a flow with neither a trigger nor an item lookup is refused, saying what it needs", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(
        load(
          "nothing",
          `import * as Effect from "effect/Effect";

export default { workflow: () => Effect.void };
`,
        ),
      );

      expect(refused.message).toBe(
        "defineFlow({ trigger, workflow }) or defineFlow({ item, workflow }) must be the module's default export",
      );
    }),
  );

  test("the type wants an item lookup of a flow with no trigger, and no schedule", () => {
    const flows = [
      // @ts-expect-error -- with neither a trigger nor an item lookup, nothing could start it.
      defineFlow({ workflow: () => Effect.void }),
      // @ts-expect-error -- a manual flow never ticks, so it takes no schedule.
      defineFlow({
        item: () => Effect.succeedNone,
        schedule: "0 * * * *",
        workflow: () => Effect.void,
      }),
    ];

    expect(flows).toHaveLength(2);
  });
});

const DEPLOY = `import { defineFlow } from "@chernabog/sdk";
import * as Effect from "effect/Effect";

export default defineFlow({ item: () => Effect.succeedNone, workflow: () => Effect.void });
`;

// A .chernabog/ whose config.yaml holds `config`, with @acme/recipes
// installed, declaring `range` as its SDK range, and holding the deploy recipe.
const withPackage = (
  config: string,
  range = ">=0.6.0 <0.8.0",
  list: "dependencies" | "devDependencies" = "dependencies",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-imports-" });
    const dir = `${configDir}/node_modules/@acme/recipes`;
    yield* fs.makeDirectory(`${dir}/flows`, { recursive: true });
    yield* fs.writeFileString(`${configDir}/config.yaml`, config);
    yield* fs.writeFileString(
      `${configDir}/package.json`,
      printJson({
        dependencies: {},
        devDependencies: { "@chernabog/sdk": BUNDLED_SDK },
        [list]: { "@acme/recipes": "1.2.0", "@chernabog/sdk": BUNDLED_SDK },
      }),
    );
    yield* fs.writeFileString(
      `${dir}/package.json`,
      printJson({
        name: "@acme/recipes",
        version: "1.2.0",
        peerDependencies: { "@chernabog/sdk": range },
        chernabog: { recipes: { deploy: { description: "Deploys", flow: "flows/deploy.ts" } } },
      }),
    );
    yield* fs.writeFileString(`${dir}/flows/deploy.ts`, DEPLOY);

    return configDir;
  });

describe("importing flows from a recipe package", () => {
  effect(
    "loads the recipe's flow under the name config.yaml gives it, knowing where it comes from",
    () =>
      Effect.gen(function* () {
        const configDir = yield* withPackage(
          'flows:\n  ship:\n    from: "@acme/recipes/deploy"\n    enabled: false\n',
        );

        const flows = yield* loadFlows(configDir);
        const ship = Option.fromUndefinedOr(flows.get("ship"));

        expect([...flows.keys()]).toEqual(["ship"]);
        expect(Option.map(Option.flatMap(ship, flowSourceOf), describeSource)).toEqual(
          Option.some("@acme/recipes@1.2.0"),
        );
        expect(yield* flowNames(configDir)).toEqual(["ship"]);
        yield* checkFlowImports(configDir);
      }),
  );

  effect("refuses a name that has both a from and a file in flows/", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configDir = yield* withPackage('flows:\n  deploy:\n    from: "@acme/recipes/deploy"\n');
      yield* fs.makeDirectory(`${configDir}/flows`);
      yield* fs.writeFileString(`${configDir}/flows/deploy.ts`, DEPLOY);

      const refused = yield* Effect.flip(loadFlows(configDir));

      expect(refused.message).toContain(
        "flows.deploy in config.yaml imports @acme/recipes/deploy, and flows/deploy.ts is a flow of the same name",
      );
    }),
  );

  effect("refuses a from naming a package that isn't installed, or a recipe it hasn't", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.flip(
        Effect.flatMap(
          withPackage('flows:\n  ship:\n    from: "@globex/recipes/ship"\n'),
          loadFlows,
        ),
      );

      expect(missing.message).toContain("@globex/recipes isn't installed in .chernabog/");

      const unknown = yield* Effect.flip(
        Effect.flatMap(withPackage('flows:\n  ship:\n    from: "@acme/recipes/ship"\n'), loadFlows),
      );

      expect(unknown.message).toContain(
        "@acme/recipes 1.2.0 has no recipe named ship (it has: deploy)",
      );
    }),
  );

  effect(
    "refuses as incompatible, naming the package, one that doesn't support this SDK or isn't a dependency",
    () =>
      Effect.gen(function* () {
        const config = 'flows:\n  ship:\n    from: "@acme/recipes/deploy"\n';

        const older = yield* Effect.flip(
          Effect.flatMap(withPackage(config, "^0.5.0"), checkFlowImports),
        );

        expect(older._tag).toBe("IncompatibleConfig");
        expect(older.message).toContain(
          `config.yaml imports flows from @acme/recipes 1.2.0, which supports @chernabog/sdk ^0.5.0`,
        );

        const dev = yield* Effect.flip(
          Effect.flatMap(
            withPackage(config, ">=0.6.0 <0.8.0", "devDependencies"),
            checkFlowImports,
          ),
        );

        expect(dev.message).toContain("which package.json doesn't list in dependencies");
      }),
  );
});
