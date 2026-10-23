import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { effect } from "../../test/effect-test.ts";
import { writeFileAtomic } from "./atomic-write.ts";

const scratch = FileSystem.FileSystem.use((fs) =>
  fs.makeTempDirectoryScoped({ prefix: "chernabog-atomic-" }),
);

describe("writeFileAtomic", () => {
  effect("replaces the file whole, and leaves nothing beside it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      const file = `${dir}/config.yaml`;

      yield* writeFileAtomic(fs, file, "repos: []\n");
      yield* writeFileAtomic(fs, file, "repos:\n  - repo: dataquail/demo\n");

      expect(yield* fs.readFileString(file)).toBe("repos:\n  - repo: dataquail/demo\n");
      expect(yield* fs.readDirectory(dir)).toEqual(["config.yaml"]);
    }),
  );

  effect("a symlinked file stays a symlink, and its target is what changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      yield* fs.makeDirectory(`${dir}/dotfiles`);
      yield* fs.writeFileString(`${dir}/dotfiles/config.yaml`, "old\n");
      yield* fs.symlink(`${dir}/dotfiles/config.yaml`, `${dir}/config.yaml`);

      yield* writeFileAtomic(fs, `${dir}/config.yaml`, "new\n");

      expect(yield* fs.readLink(`${dir}/config.yaml`)).toBe(`${dir}/dotfiles/config.yaml`);
      expect(yield* fs.readFileString(`${dir}/dotfiles/config.yaml`)).toBe("new\n");
    }),
  );

  effect("a write that fails leaves the file as it was", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      const file = `${dir}/config.yaml`;
      yield* fs.writeFileString(file, "kept\n");
      yield* fs.chmod(dir, 0o500);

      const failed = yield* Effect.flip(writeFileAtomic(fs, file, "lost\n"));
      yield* fs.chmod(dir, 0o700);

      expect(failed._tag).toBe("PlatformError");
      expect(yield* fs.readFileString(file)).toBe("kept\n");
      expect(yield* fs.readDirectory(dir)).toEqual(["config.yaml"]);
    }),
  );
});
