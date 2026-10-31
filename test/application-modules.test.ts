import { makeEventBus } from "@effect-server-utils/cqrs";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { applicationModules } from "../src/interface/application-modules.ts";
import { EngineAt, RunFlowsCommands, RunsQueries } from "../src/modules/runs/runs.platform.ts";
import { Home, homePaths } from "../src/platform/home.ts";
import { effect } from "./effect-test.ts";

// The engine slot of the module list over a runtime with no flows and a
// state.db in a scratch home, with only the root's services beneath it.
const engineInScratch = Layer.unwrap(
  FileSystem.FileSystem.use((fs) =>
    fs.makeTempDirectoryScoped({ prefix: "chernabog-modules-" }),
  ).pipe(
    Effect.map((home) =>
      applicationModules.engine.pipe(
        Layer.provide(applicationModules.runtime({ handles: [], services: () => Option.none() })),
        Layer.provide(makeEventBus()),
        Layer.provide(EngineAt(homePaths(home).state)),
        Layer.provide(Home.at(home, home)),
      ),
    ),
  ),
);

// Each module wires itself in its <module>.module.ts (ADR 12): the roots merge
// the modules, and no module hands them a layer of loose adapters to order.
describe("a module's wiring", () => {
  effect("each module assembles itself in its module.ts, with no layer.ts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL("../src/modules", import.meta.url));
      const modules = yield* fs.readDirectory(root);

      for (const module of modules) {
        const files = yield* fs.readDirectory(path.join(root, module));

        expect(files).toContain(`${module}.module.ts`);
        expect(files.filter((file) => file.endsWith(".layer.ts"))).toEqual([]);
      }
    }),
  );

  // What a process with an engine adds needs only what differs between roots:
  // the engine over a state.db, the runtime of the flows it loaded, the bus and
  // the platform. The runs' stores are the module's own.
  effect("the modules a process with an engine adds take only the root's services", () =>
    Effect.gen(function* () {
      const active = yield* (yield* RunsQueries).ListActiveRunsQuery({
        repo: Option.none(),
        persona: Option.none(),
        flow: Option.none(),
      });

      const recovered = yield* (yield* RunFlowsCommands).RecoverRunsCommand();

      expect(active.runs).toEqual([]);
      expect(recovered.executed).toEqual([]);
    }).pipe(Effect.provide(engineInScratch)),
  );
});
