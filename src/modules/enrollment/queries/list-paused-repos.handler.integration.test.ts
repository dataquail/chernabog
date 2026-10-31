import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { effectAtHome } from "../../../../test/effect-test.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { EnrolledRepoRoot } from "../domain/enrolled-repo/enrolled-repo.root.ts";
import { EnrolledReposRepository } from "../domain/enrolled-repo/enrolled-repos.repository.ts";
import { EnrolledReposRepositoryLive } from "../infrastructure/repositories/enrolled-repos.repository-live.ts";
import { listPausedReposHandler } from "./list-paused-repos.handler.ts";

const repo = (slug: string, paused: boolean) =>
  EnrolledRepoRoot.make({ repo: RepoSlug.make(slug), path: `/src/${slug}`, defaults: {}, paused });

// Machine config in the scratch home, holding `entries`, as the live repository writes it.
const enrol = (entries: ReadonlyArray<EnrolledRepoRoot>) =>
  EnrolledReposRepository.use((repository) =>
    Effect.forEach(entries, (saved) => repository.upsertOne(saved), { discard: true }),
  );

const machineOf = (repos: ReadonlyArray<EnrolledRepoRoot>) =>
  Layer.effectDiscard(enrol(repos)).pipe(Layer.provideMerge(EnrolledReposRepositoryLive));

describe("listPausedReposHandler", () => {
  effectAtHome("lists the paused repos by slug", () =>
    Effect.gen(function* () {
      const paused = yield* listPausedReposHandler();

      expect(paused.repos).toEqual([RepoSlug.make("dataquail/demo")]);
    }).pipe(
      Effect.provide(machineOf([repo("dataquail/demo", true), repo("dataquail/other", false)])),
    ),
  );
});
