import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { effectAtHome } from "../../../../test/effect-test.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { EnrolledRepoRoot } from "../domain/enrolled-repo/enrolled-repo.root.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { EnrolledReposRepositoryLive } from "../infrastructure/repositories/enrolled-repos.repository-live.ts";
import { listPersonasInUseHandler } from "./list-personas-in-use.handler.ts";

const repo = (slug: string, personas: ReadonlyArray<string>) =>
  EnrolledRepoRoot.make({
    repo: RepoSlug.make(slug),
    path: `/src/${slug}`,
    defaults: {},
    personas: Object.fromEntries(personas.map((login) => [login, {}])),
    paused: false,
  });

// Machine config in the scratch home, holding `entries`, as the live repository writes it.
const enrol = (entries: ReadonlyArray<EnrolledRepoRoot>) =>
  EnrolledReposRepository.use((repository) =>
    Effect.forEach(entries, (saved) => repository.save(saved), { discard: true }),
  );

const machineOf = (repos: ReadonlyArray<EnrolledRepoRoot>) =>
  Layer.effectDiscard(enrol(repos)).pipe(Layer.provideMerge(EnrolledReposRepositoryLive));

describe("listPersonasInUseHandler", () => {
  effectAtHome("lists each login an enrolled repo runs as, once", () =>
    Effect.gen(function* () {
      expect((yield* listPersonasInUseHandler()).logins).toEqual(["bob", "alice"]);
    }).pipe(
      Effect.provide(
        machineOf([
          repo("dataquail/demo", ["bob"]),
          repo("dataquail/other", ["alice", "bob"]),
          EnrolledRepoRoot.make({
            repo: RepoSlug.make("dataquail/implicit"),
            path: "/src/implicit",
            defaults: {},
            paused: false,
          }),
        ]),
      ),
    ),
  );
});
