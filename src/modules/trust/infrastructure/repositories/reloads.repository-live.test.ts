import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { effectAtHome } from "../../../../../test/effect-test.ts";
import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { Home, homePaths } from "../../../../platform/home.ts";
import { ReloadsRepository } from "../../domain/ports/repositories/reloads.repository.ts";
import { ReloadRoot } from "../../domain/reload/reload.root.ts";
import { ReloadsRepositoryLive } from "./reloads.repository-live.ts";

const demo = RepoSlug.make("dataquail/demo");
const other = RepoSlug.make("dataquail/other");

const opened = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = homePaths((yield* Home).root).reloaded;

  return { fs, file, reloads: yield* ReloadsRepository };
}).pipe(Effect.provide(ReloadsRepositoryLive));

describe("ReloadsRepositoryLive", () => {
  effectAtHome("saves a repo's tree by slug and reads it back, keeping the others", () =>
    Effect.gen(function* () {
      const { file, fs, reloads } = yield* opened;
      yield* reloads.save(ReloadRoot.make({ repo: other, tree: "cccc" }));
      yield* reloads.save(ReloadRoot.make({ repo: demo, tree: "aaaa" }));
      yield* reloads.save(ReloadRoot.make({ repo: demo, tree: "bbbb" }));

      expect(yield* reloads.findOne(demo)).toEqual(
        Option.some(ReloadRoot.make({ repo: demo, tree: "bbbb" })),
      );
      expect(yield* fs.readFileString(file)).toBe(
        '{\n  "dataquail/other": "cccc",\n  "dataquail/demo": "bbbb"\n}\n',
      );
    }),
  );

  effectAtHome("has none when reloaded.json is missing or does not parse", () =>
    Effect.gen(function* () {
      const { file, fs, reloads } = yield* opened;

      expect(yield* reloads.findOne(demo)).toEqual(Option.none());

      yield* fs.writeFileString(file, "{ not json");
      expect(yield* reloads.findOne(demo)).toEqual(Option.none());
    }),
  );
});
