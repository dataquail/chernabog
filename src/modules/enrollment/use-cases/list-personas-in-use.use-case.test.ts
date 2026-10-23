import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { EnrolledRepoRoot } from "../domain/enrolled-repo/enrolled-repo.root.ts";
import { EnrolledReposRepositoryFake } from "../infrastructure/repositories/enrolled-repos.repository-fake.ts";
import { listPersonasInUseUseCase } from "./list-personas-in-use.use-case.ts";

const repo = (slug: string, personas: ReadonlyArray<string>) =>
  EnrolledRepoRoot.make({
    repo: RepoSlug.make(slug),
    path: `/src/${slug}`,
    defaults: {},
    personas: Object.fromEntries(personas.map((login) => [login, {}])),
    paused: false,
  });

describe("listPersonasInUseUseCase", () => {
  effect("lists each login an enrolled repo runs as, once", () =>
    Effect.gen(function* () {
      expect((yield* listPersonasInUseUseCase()).logins).toEqual(["bob", "alice"]);
    }).pipe(
      Effect.provide(
        EnrolledReposRepositoryFake([
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
