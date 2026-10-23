import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { defineFlow, isManual } from "../packages/sdk/src/flow.ts";
import { loadFlows } from "../src/platform/flow-loader.ts";
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
