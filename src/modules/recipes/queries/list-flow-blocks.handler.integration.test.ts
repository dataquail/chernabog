import { BunServices } from "@effect/platform-bun";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { effectAtHomeWith } from "../../../../test/effect-test.ts";
import { Exec } from "../../../platform/exec.ts";
import { FlowCompilerClientLive } from "../infrastructure/clients/flow-compiler.client-live.ts";
import { listFlowBlocksHandler } from "./list-flow-blocks.handler.ts";

const effect = effectAtHomeWith(Exec.layer.pipe(Layer.provide(BunServices.layer)));

// A checkout whose .chernabog/ has this repo's SDK installed, or nothing.
const checkout = (installed: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-blocks-" });

    yield* fs.makeDirectory(path.join(root, ".chernabog"), { recursive: true });

    if (installed) {
      const modules = yield* path.fromFileUrl(new URL("../../../../node_modules", import.meta.url));

      yield* fs.symlink(modules, path.join(root, ".chernabog", "node_modules"));
    }

    return root;
  });

describe("listFlowBlocksHandler", () => {
  effect("says what a document can use, by the SDK the repo has installed", () =>
    Effect.gen(function* () {
      const root = yield* checkout(true);
      const catalogue = yield* listFlowBlocksHandler({ root });

      const named = catalogue.blocks.find((block) => block.name === "branch.push");

      expect(named?.gives).toEqual({ pushed: "Pushed: proof for pr.open" });
      expect(named?.inputs.map((input) => input.name)).toContain("committed");
      expect(catalogue.loopStates).toContain("epic.tasks");
      expect(catalogue.laneScopes).toContain("epic.task");
    }).pipe(Effect.provide(Layer.fresh(FlowCompilerClientLive))),
  );

  effect("says why when the repo has no SDK to ask", () =>
    Effect.gen(function* () {
      const root = yield* checkout(false);
      const refused = yield* Effect.flip(listFlowBlocksHandler({ root }));

      expect(refused.message).toContain("bun install");
    }).pipe(Effect.provide(Layer.fresh(FlowCompilerClientLive))),
  );
});
