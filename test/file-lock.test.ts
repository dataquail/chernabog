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

// A process trying for the engine's lock, holding it a moment if it gets it:
// it prints whether it did.
const contenderSource = (lock: string) => `
import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import { acquireLock } from "./src/platform/lock.ts";

await Effect.runPromise(
  Effect.scoped(acquireLock("${lock}", "contender").pipe(Effect.andThen(Effect.sleep("300 millis")))).pipe(
    Effect.match({ onSuccess: () => "got", onFailure: () => "refused" }),
    Effect.tap((said) => Effect.sync(() => process.stdout.write(said))),
    Effect.provide(BunServices.layer),
  ),
);
`;

const contender = (root: string, lock: string) =>
  Exec.use((exec) => exec.run(bunExecutable(), ["-e", contenderSource(lock)], { cwd: root }));

describe("the engine's lock across processes", () => {
  effect("of processes starting at once, exactly one gets it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-lock-" });
      const root = yield* (yield* Path.Path).fromFileUrl(new URL("..", import.meta.url));

      for (let round = 0; round < 5; round++) {
        const lock = `${dir}/engine-${round}.lock`;

        const said = yield* Effect.forEach(
          Array.from({ length: 6 }, () => lock),
          (one) => contender(root, one),
          { concurrency: 6 },
        );

        expect(said.map((one) => one.stdout).filter((one) => one === "got").length).toBe(1);
        expect(said.map((one) => one.stderr)).toEqual(Array.from({ length: 6 }, () => ""));
      }
    }).pipe(Effect.provide(Exec.layer)),
  );
});

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
