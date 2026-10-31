import { makeEventBus } from "@effect-server-utils/cqrs";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../test/effect-test.ts";
import { RunId } from "../../kernel/run-id.id.ts";
import {
  EngineAt,
  RunsCommands,
  RuntimeLayer,
  type RunView,
} from "../../modules/runs/runs.platform.ts";
import { Home, homePaths } from "../../platform/home.ts";
import { applicationModules } from "../application-modules.ts";
import { subscribeRunEndings } from "./run-endings.event-adapter.ts";

// The modules a daemon adds, over a runtime with no flows and a state.db in a
// scratch home, on one bus.
const daemonInScratch = Layer.unwrap(
  FileSystem.FileSystem.use((fs) =>
    fs.makeTempDirectoryScoped({ prefix: "chernabog-run-endings-" }),
  ).pipe(
    Effect.map((home) =>
      applicationModules.engine.pipe(
        Layer.provide(RuntimeLayer({ handles: [], services: () => Option.none() })),
        Layer.provideMerge(makeEventBus()),
        Layer.provide(EngineAt(homePaths(home).state)),
        Layer.provide(Home.at(home, home)),
      ),
    ),
  ),
);

const start = (id: string) =>
  RunsCommands.use((runs) =>
    runs.StartRunCommand({
      id: RunId.make(id),
      coreVersion: "0.7.0",
      repo: "demo",
      persona: Option.some("bob"),
      flow: "implement",
      itemKey: `issue-${id}`,
      itemTitle: Option.none(),
      itemUrl: Option.none(),
      item: Option.none(),
    }),
  );

describe("subscribeRunEndings", () => {
  effect("tells the daemon of each run that ends, as the run now reads", () =>
    Effect.gen(function* () {
      const ended: Array<RunView> = [];

      yield* subscribeRunEndings((run) => Effect.sync(() => ended.push(run)));

      yield* start("a");
      yield* start("b");
      yield* RunsCommands.use((runs) =>
        runs.FinishRunCommand({ runId: RunId.make("a"), status: "failed", summary: "it broke" }),
      );

      expect(ended.map((run) => [run.id, run.repo, run.flow, run.status, run.summary])).toEqual([
        [RunId.make("a"), "demo", "implement", "failed", Option.some("it broke")],
      ]);
    }).pipe(Effect.provide(daemonInScratch)),
  );
});
