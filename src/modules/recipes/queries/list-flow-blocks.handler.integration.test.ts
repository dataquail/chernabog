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

// A checkout whose .chernabog/ has this repo's SDK installed, or nothing, and
// these files in its stages/.
const checkout = (installed: boolean, stages: { readonly [file: string]: string } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-blocks-" });

    yield* fs.makeDirectory(path.join(root, ".chernabog"), { recursive: true });

    if (installed) {
      const modules = yield* path.fromFileUrl(new URL("../../../../node_modules", import.meta.url));

      yield* fs.symlink(modules, path.join(root, ".chernabog", "node_modules"));
    }

    for (const [file, text] of Object.entries(stages)) {
      yield* fs.makeDirectory(path.join(root, ".chernabog", "stages"), { recursive: true });
      yield* fs.writeFileString(path.join(root, ".chernabog", "stages", file), text);
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

  effect(
    "lists the repo's Effect stages, and leaves out a shell stage and one that won't load",
    () =>
      Effect.gen(function* () {
        const root = yield* checkout(true, {
          "count-words.ts": [
            'import { defineStage } from "@chernabog/sdk";',
            'import * as Effect from "effect/Effect";',
            'import * as Schema from "effect/Schema";',
            "",
            "export default defineStage({",
            '  name: "count-words",',
            "  input: Schema.Struct({ text: Schema.String, lang: Schema.optionalKey(Schema.String) }),",
            "  output: Schema.Struct({ words: Schema.Number }),",
            "  run: (input) => Effect.succeed({ words: input.text.split(' ').length }),",
            "});",
            "",
          ].join("\n"),
          "broken.ts": "export default 5;\n",
          notify: "#!/bin/sh\necho '{}'\n",
        });

        const catalogue = yield* listFlowBlocksHandler({ root });

        expect(catalogue.stages).toEqual([
          {
            name: "count-words",
            inputs: [
              { name: "text", required: true, under: "in or with", kind: "string" },
              { name: "lang", required: false, under: "in or with", kind: "string" },
            ],
            gives: { words: "number" },
            failures: ["Skip", "StepFailed"],
          },
        ]);
      }).pipe(Effect.provide(Layer.fresh(FlowCompilerClientLive))),
  );

  effect("lists no stages for a repo with none", () =>
    Effect.gen(function* () {
      const root = yield* checkout(true);

      expect((yield* listFlowBlocksHandler({ root })).stages).toEqual([]);
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
