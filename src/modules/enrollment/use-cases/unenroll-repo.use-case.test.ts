import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { Checkout } from "../domain/enrolled-repo/checkout.value-object.ts";
import { EnrolledRepoRoot } from "../domain/enrolled-repo/enrolled-repo.root.ts";
import { TeamFlows } from "../domain/enrolled-repo/team-flows.value-object.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { CheckoutsClientFake } from "../infrastructure/clients/checkouts.client-fake.ts";
import { ViewerClientFake } from "../infrastructure/clients/viewer.client-fake.ts";
import { EnrolledReposRepositoryFake } from "../infrastructure/repositories/enrolled-repos.repository-fake.ts";
import { unenrollRepoUseCase } from "./unenroll-repo.use-case.ts";

const demo = RepoSlug.make("dataquail/demo");

const team = TeamFlows.make({
  agent: Option.none(),
  runners: Option.none(),
  flows: { fix: { enabled: false }, review: { runners: ["bob"] } },
});

const here = Checkout.make({
  root: "/src/demo",
  repo: demo,
  baseBranch: "main",
  flows: ["fix", "implement", "review"],
  team,
});

const entry = (fields: Partial<ConstructorParameters<typeof EnrolledRepoRoot>[0]> = {}) =>
  EnrolledRepoRoot.make({ repo: demo, path: "/src/demo", defaults: {}, paused: false, ...fields });

const stored = EnrolledReposRepository.use((repository) => repository.findAll);

const machineOf = (repos: ReadonlyArray<EnrolledRepoRoot>, present: ReadonlyArray<string> = []) =>
  Layer.mergeAll(
    EnrolledReposRepositoryFake(repos),
    CheckoutsClientFake([here], present),
    ViewerClientFake(Option.some("carol")),
  );

describe("unenrollRepoUseCase", () => {
  effect("removes the repo named, settings and all, and says what it was", () =>
    Effect.gen(function* () {
      const removed = yield* unenrollRepoUseCase("dataquail/demo");

      expect([removed.name, removed.path]).toEqual(["demo", "/src/demo"]);
      expect(yield* stored).toEqual([]);
      expect((yield* Effect.flip(unenrollRepoUseCase("demo")))._tag).toBe("RepoNotEnrolled");
    }).pipe(Effect.provide(machineOf([entry({ defaults: { flows: { implement: {} } } })]))),
  );
});
