import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { effectAtHome } from "../../../../../test/effect-test.ts";
import { Home, homePaths } from "../../../../config.ts";
import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { EnrolledRepoRoot } from "../../domain/enrolled-repo/enrolled-repo.root.ts";
import { EnrolledRepoRootOps } from "../../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledReposRepository } from "../../domain/ports/repositories/enrolled-repos.repository.ts";
import { EnrolledReposRepositoryLive } from "./enrolled-repos.repository-live.ts";

const CONFIG =
  "repos:\n  # the one I work on\n  - repo: dataquail/demo\n    path: /src/demo\n    flows: { implement: {} }\n  - repo: dataquail/other\n    path: /src/other\n";

// Machine config as CONFIG, and the repository over it.
const seeded = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = homePaths((yield* Home).root);
  yield* fs.writeFileString(paths.machineConfig, CONFIG);

  const repository = yield* EnrolledReposRepository;
  const repos = yield* repository.findAll;

  return { fs, paths, repository, demo: repos[0] };
}).pipe(Effect.provide(EnrolledReposRepositoryLive));

describe("EnrolledReposRepositoryLive", () => {
  effectAtHome("reads every entry of machine config, none paused without paused.json", () =>
    Effect.gen(function* () {
      const { repository } = yield* seeded;
      const repos = yield* repository.findAll;

      expect(repos.map((repo) => [repo.repo, repo.path, repo.paused])).toEqual([
        ["dataquail/demo", "/src/demo", false],
        ["dataquail/other", "/src/other", false],
      ]);
      expect(repos[0].defaults).toEqual({ flows: { implement: {} } });
    }),
  );

  effectAtHome("pausing writes paused.json by slug and leaves machine config as it was", () =>
    Effect.gen(function* () {
      const { demo, fs, paths, repository } = yield* seeded;
      yield* repository.save(EnrolledRepoRootOps.pause(demo));

      expect(yield* fs.readFileString(paths.paused)).toBe('["dataquail/demo"]\n');
      expect(yield* fs.readFileString(paths.machineConfig)).toBe(CONFIG);
      expect((yield* repository.findAll).map((repo) => repo.paused)).toEqual([true, false]);

      yield* repository.save(EnrolledRepoRootOps.resume(demo));
      expect(yield* fs.readFileString(paths.paused)).toBe("[]\n");
    }),
  );

  effectAtHome("saving a changed entry edits it in place, keeping the comments", () =>
    Effect.gen(function* () {
      const { demo, fs, paths, repository } = yield* seeded;
      yield* repository.save(EnrolledRepoRootOps.setFlow(demo, Option.none(), "review", true));

      const text = yield* fs.readFileString(paths.machineConfig);

      expect(text).toContain("# the one I work on");
      expect((yield* repository.findAll)[0].defaults.flows).toEqual({ implement: {}, review: {} });
      expect(yield* fs.exists(paths.paused)).toBe(false);
    }),
  );

  effectAtHome("refuses to save a repo that isn't enrolled", () =>
    Effect.gen(function* () {
      const { demo, repository } = yield* seeded;

      const refused = yield* Effect.flip(
        repository.save(EnrolledRepoRoot.make({ ...demo, repo: RepoSlug.make("dataquail/gone") })),
      );

      expect(refused.message).toBe("dataquail/gone isn't enrolled; run chernabog enroll in it");
    }),
  );
});
