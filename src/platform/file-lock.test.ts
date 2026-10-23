import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { effect } from "../../test/effect-test.ts";
import { updateFile } from "./file-lock.ts";

const scratch = FileSystem.FileSystem.use((fs) =>
  fs.makeTempDirectoryScoped({ prefix: "chernabog-lock-" }),
);

// Adds a line to the file, slowly, so updates that don't take turns overlap.
const addLine = (fs: FileSystem.FileSystem, file: string, line: string) =>
  updateFile(fs, file, "a test", (text) =>
    Effect.gen(function* () {
      // Lets the other updates run, and find the file locked.
      yield* Effect.yieldNow;

      return [line, Option.some(`${Option.getOrElse(text, () => "")}${line}\n`)] as const;
    }),
  );

const linesOf = (fs: FileSystem.FileSystem, file: string) =>
  fs
    .readFileString(file)
    .pipe(Effect.map((text) => text.split("\n").filter((line) => line.length > 0)));

describe("updateFile", () => {
  effect("updates at once take turns, so none is lost, and leave no lock behind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      const file = `${dir}/paused.json`;

      yield* Effect.forEach(
        Array.from({ length: 10 }, (_, index) => `line ${index}`),
        (line) => addLine(fs, file, line),
        { concurrency: 10 },
      );

      expect((yield* linesOf(fs, file)).toSorted()).toEqual(
        Array.from({ length: 10 }, (_, index) => `line ${index}`).toSorted(),
      );
      expect(yield* fs.readDirectory(dir)).toEqual(["paused.json"]);
    }),
  );

  effect("takes over a lock its holder left when it died", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      const file = `${dir}/trust.json`;
      yield* fs.writeFileString(
        `${file}.lock`,
        JSON.stringify({ pid: 2 ** 22 + 1, purpose: "a crash", since: "2026-10-23T00:00:00Z" }),
      );

      yield* addLine(fs, file, "after the crash");

      expect(yield* linesOf(fs, file)).toEqual(["after the crash"]);
    }),
  );

  effect("gives up on a lock a live process keeps holding, saying who", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      const file = `${dir}/config.yaml`;
      yield* fs.writeFileString(
        `${file}.lock`,
        JSON.stringify({
          pid: process.pid,
          purpose: "a stuck edit",
          since: "2026-10-23T00:00:00Z",
        }),
      );

      const busy = yield* Effect.flip(addLine(fs, file, "never"));

      expect(busy._tag).toBe("FileBusy");
      expect(busy.message).toContain(`pid ${process.pid} (a stuck edit)`);
      expect(yield* fs.exists(file)).toBe(false);
    }),
  );

  effect("an edit saved while it changes the file is kept: it changes what's there now", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      const file = `${dir}/config.yaml`;
      yield* fs.writeFileString(file, "mine\n");
      let runs = 0;

      yield* updateFile(fs, file, "a test", (text) =>
        Effect.gen(function* () {
          runs += 1;

          // A person's editor saves the file, taking no lock, the first time.
          if (runs === 1) {
            yield* fs.writeFileString(file, "mine\nfrom the editor\n");
          }

          return [
            runs,
            Option.some(`${Option.getOrElse(text, () => "")}from chernabog\n`),
          ] as const;
        }),
      );

      expect(runs).toBe(2);
      expect(yield* linesOf(fs, file)).toEqual(["mine", "from the editor", "from chernabog"]);
    }),
  );
});
