import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { EnrolledRepoRoot } from "../domain/enrolled-repo/enrolled-repo.root.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { EnrolledReposRepositoryFake } from "../infrastructure/repositories/enrolled-repos.repository-fake.ts";
import { pauseRepoUseCase } from "./pause-repo.use-case.ts";

const demo = EnrolledRepoRoot.make({
  repo: RepoSlug.make("dataquail/demo"),
  path: "/src/demo",
  defaults: {},
  paused: false,
});

describe("pauseRepoUseCase", () => {
  effect("pauses the repo named, by its name, slug or path", () =>
    Effect.gen(function* () {
      const states = yield* Effect.forEach(["demo", "dataquail/demo", "/src/demo"], (name) =>
        pauseRepoUseCase(name),
      );

      expect(states.map((state) => [state.name, state.repo, state.paused, state.changed])).toEqual([
        ["demo", "dataquail/demo", true, true],
        ["demo", "dataquail/demo", true, false],
        ["demo", "dataquail/demo", true, false],
      ]);
    }).pipe(Effect.provide(EnrolledReposRepositoryFake([demo]))),
  );

  effect("stores the repo paused, and pausing it again changes nothing", () =>
    Effect.gen(function* () {
      yield* pauseRepoUseCase("demo");
      const again = yield* pauseRepoUseCase("demo");
      const stored = yield* (yield* EnrolledReposRepository).findAll;

      expect(again.changed).toBe(false);
      expect(stored.map((repo) => repo.paused)).toEqual([true]);
    }).pipe(Effect.provide(EnrolledReposRepositoryFake([demo]))),
  );

  effect("fails naming the repos enrolled when none answers to the name", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(pauseRepoUseCase("nope"));

      expect(refused.message).toBe(
        "no enrolled repo named nope (enrolled: demo); run chernabog enroll in it",
      );
    }).pipe(Effect.provide(EnrolledReposRepositoryFake([demo]))),
  );
});
