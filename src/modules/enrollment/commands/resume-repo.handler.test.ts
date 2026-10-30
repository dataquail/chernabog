import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { EnrolledRepoRoot } from "../domain/enrolled-repo/enrolled-repo.root.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { EnrolledReposRepositoryFake } from "../infrastructure/repositories/enrolled-repos.repository-fake.ts";
import { resumeRepoHandler } from "./resume-repo.handler.ts";

const demo = EnrolledRepoRoot.make({
  repo: RepoSlug.make("dataquail/demo"),
  path: "/src/demo",
  defaults: {},
  paused: true,
});

describe("resumeRepoHandler", () => {
  effect("lets a paused repo start runs again, and resuming it again changes nothing", () =>
    Effect.gen(function* () {
      const resumed = yield* resumeRepoHandler({ name: "demo" });
      const again = yield* resumeRepoHandler({ name: "demo" });
      const stored = yield* (yield* EnrolledReposRepository).findAll;

      expect([resumed.paused, resumed.changed, again.changed]).toEqual([false, true, false]);
      expect(stored.map((repo) => repo.paused)).toEqual([false]);
    }).pipe(Effect.provide(EnrolledReposRepositoryFake([demo]))),
  );

  effect("fails when no enrolled repo answers to the name", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(resumeRepoHandler({ name: "nope" }));

      expect(refused._tag).toBe("RepoNotEnrolled");
    }).pipe(Effect.provide(EnrolledReposRepositoryFake([demo]))),
  );
});
