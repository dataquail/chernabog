import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { effectAtHome } from "../../../../../test/effect-test.ts";
import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { Home, homePaths } from "../../../../platform/home.ts";
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

  effectAtHome("saving a repo not enrolled adds its entry at the end", () =>
    Effect.gen(function* () {
      const { demo, fs, paths, repository } = yield* seeded;
      yield* repository.save(
        EnrolledRepoRoot.make({
          ...demo,
          repo: RepoSlug.make("dataquail/new"),
          path: "/src/new",
          baseBranch: "trunk",
          defaults: { flows: { review: {} } },
        }),
      );

      expect(yield* fs.readFileString(paths.machineConfig)).toBe(
        `${CONFIG}  - repo: dataquail/new\n    path: /src/new\n    baseBranch: trunk\n    flows:\n      review: {}\n`,
      );
    }),
  );

  effectAtHome("removing a repo drops its entry, settings and all, and keeps the rest", () =>
    Effect.gen(function* () {
      const { fs, paths, repository } = yield* seeded;
      yield* repository.remove((yield* repository.findAll)[1]);

      expect(yield* fs.readFileString(paths.machineConfig)).toBe(
        "repos:\n  # the one I work on\n  - repo: dataquail/demo\n    path: /src/demo\n    flows: { implement: {} }\n",
      );
    }),
  );
});
