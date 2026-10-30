import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { EnrolledRepoRoot } from "../domain/enrolled-repo/enrolled-repo.root.ts";
import { EnrolledReposRepositoryFake } from "../infrastructure/repositories/enrolled-repos.repository-fake.ts";
import { listPausedReposHandler } from "./list-paused-repos.handler.ts";

const repo = (slug: string, paused: boolean) =>
  EnrolledRepoRoot.make({ repo: RepoSlug.make(slug), path: `/src/${slug}`, defaults: {}, paused });

describe("listPausedReposHandler", () => {
  effect("lists the paused repos by slug", () =>
    Effect.gen(function* () {
      const paused = yield* listPausedReposHandler();

      expect(paused.repos).toEqual([RepoSlug.make("dataquail/demo")]);
    }).pipe(
      Effect.provide(
        EnrolledReposRepositoryFake([repo("dataquail/demo", true), repo("dataquail/other", false)]),
      ),
    ),
  );
});
