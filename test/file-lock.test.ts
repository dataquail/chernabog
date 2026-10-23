import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { Exec } from "../src/platform/exec.ts";
import { bunExecutable } from "../src/platform/self.ts";
import { effect } from "./effect-test.ts";

const COUNT = 60;

// A process adding COUNT lines tagged `tag` to the file, one update each,
// pausing inside each so that two such processes overlap.
const writerSource = (file: string, tag: string) => `
import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { Exec } from "../src/platform/exec.ts";
import { bunExecutable } from "../src/platform/self.ts";
import * as Option from "effect/Option";
import { updateFile } from "./src/platform/file-lock.ts";

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (let index = 0; index < ${COUNT}; index++) {
      yield* updateFile(fs, "${file}", "writer ${tag}", (text) =>
        Effect.sleep("2 millis").pipe(
          Effect.as([index, Option.some(Option.getOrElse(text, () => "") + "${tag}-" + index + "\\n")] as const),
        ),
      );
    }
  }).pipe(Effect.provide(BunServices.layer)),
);
`;

const writer = (root: string, file: string, tag: string) =>
  Exec.use((exec) => exec.run(bunExecutable(), ["-e", writerSource(file, tag)], { cwd: root }));

describe("updateFile across processes", () => {
  effect("three processes changing one file at once take turns, and lose nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-lock-" });
      const file = `${dir}/config.yaml`;

      const root = yield* (yield* Path.Path).fromFileUrl(new URL("..", import.meta.url));

      const exits = yield* Effect.forEach(["a", "b", "c"], (tag) => writer(root, file, tag), {
        concurrency: 3,
      });

      expect(exits.map((exit) => [exit.exitCode, exit.stderr])).toEqual([
        [0, ""],
        [0, ""],
        [0, ""],
      ]);

      const lines = (yield* fs.readFileString(file)).split("\n").filter((line) => line.length > 0);

      expect(lines.length).toBe(3 * COUNT);
      expect(new Set(lines).size).toBe(3 * COUNT);
    }).pipe(Effect.provide(Exec.layer)),
  );
});
