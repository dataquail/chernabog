import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { effectAtHome } from "../../../../../test/effect-test.ts";
import { ChernabogDirClient } from "../../domain/ports/clients/chernabog-dir.client.ts";
import { ChernabogDirClientLive } from "./chernabog-dir.client-live.ts";

describe("ChernabogDirClientLive", () => {
  effectAtHome("reads, writes, appends to and lists a checkout's files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-dir-" });
      const dir = yield* ChernabogDirClient;

      expect(yield* dir.read(root, ".chernabog/flows/review.ts")).toEqual(Option.none());
      expect(yield* dir.list(root, ".chernabog/flows")).toEqual([]);

      yield* dir.write(root, ".chernabog/flows/review.ts", "export {};\n");
      yield* dir.write(root, ".chernabog/flows/implement.ts", "export {};\n");
      yield* dir.write(root, ".gitignore", "dist\n");
      yield* dir.append(root, ".gitignore", "node_modules/\n");

      expect(yield* dir.read(root, ".chernabog/flows/review.ts")).toEqual(
        Option.some("export {};\n"),
      );
      expect(yield* dir.list(root, ".chernabog/flows")).toEqual(["implement.ts", "review.ts"]);
      expect(yield* dir.read(root, ".gitignore")).toEqual(Option.some("dist\nnode_modules/\n"));
    }).pipe(Effect.provide(ChernabogDirClientLive)),
  );
});
