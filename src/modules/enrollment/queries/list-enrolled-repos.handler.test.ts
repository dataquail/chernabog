import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { EnrolledRepoRoot } from "../domain/enrolled-repo/enrolled-repo.root.ts";
import { EnrolledReposRepositoryFake } from "../infrastructure/repositories/enrolled-repos.repository-fake.ts";
import { listEnrolledReposHandler } from "./list-enrolled-repos.handler.ts";

const repos = [
  EnrolledRepoRoot.make({
    repo: RepoSlug.make("dataquail/demo"),
    path: "/src/demo",
    defaults: {},
    paused: false,
  }),
  EnrolledRepoRoot.make({
    repo: RepoSlug.make("dataquail/other"),
    name: "other-2",
    path: "/src/other",
    defaults: {},
    paused: false,
  }),
];

describe("listEnrolledReposHandler", () => {
  effect("lists every enrolled repo", () =>
    Effect.gen(function* () {
      const listed = yield* listEnrolledReposHandler({ name: Option.none() });

      expect(listed.repos.map((repo) => [repo.name, repo.repo, repo.path])).toEqual([
        ["demo", "dataquail/demo", "/src/demo"],
        ["other-2", "dataquail/other", "/src/other"],
      ]);
    }).pipe(Effect.provide(EnrolledReposRepositoryFake(repos))),
  );

  effect("lists only the one named, and fails for a name no repo answers to", () =>
    Effect.gen(function* () {
      expect(
        (yield* listEnrolledReposHandler({ name: Option.some("dataquail/other") })).repos.map(
          (repo) => repo.name,
        ),
      ).toEqual(["other-2"]);
      expect(
        (yield* Effect.flip(listEnrolledReposHandler({ name: Option.some("nope") })))._tag,
      ).toBe("RepoNotEnrolled");
    }).pipe(Effect.provide(EnrolledReposRepositoryFake(repos))),
  );
});
