import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { Checkout } from "../domain/enrolled-repo/checkout.value-object.ts";
import { EnrolledRepoRoot } from "../domain/enrolled-repo/enrolled-repo.root.ts";
import { TeamFlows } from "../domain/enrolled-repo/team-flows.value-object.ts";
import { CheckoutsClientFake } from "../infrastructure/clients/checkouts.client-fake.ts";
import { ViewerClientFake } from "../infrastructure/clients/viewer.client-fake.ts";
import { EnrolledReposRepositoryFake } from "../infrastructure/repositories/enrolled-repos.repository-fake.ts";
import { listMovedReposUseCase } from "./list-moved-repos.use-case.ts";

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

const machineOf = (repos: ReadonlyArray<EnrolledRepoRoot>, present: ReadonlyArray<string> = []) =>
  Layer.mergeAll(
    EnrolledReposRepositoryFake(repos),
    CheckoutsClientFake([here], present),
    ViewerClientFake(Option.some("carol")),
  );

describe("listMovedReposUseCase", () => {
  effect("lists the repo's entries whose checkout is gone, with the name each was given", () =>
    Effect.gen(function* () {
      const { repos } = yield* listMovedReposUseCase("/src/demo");

      expect(repos.map((repo) => [repo.name, repo.named, repo.path])).toEqual([
        ["old", Option.some("old"), "/old/demo"],
      ]);
    }).pipe(
      Effect.provide(
        machineOf(
          [
            entry({ path: "/old/demo", name: "old" }),
            entry({ path: "/kept/demo", name: "kept" }),
            entry({ repo: RepoSlug.make("dataquail/other"), path: "/gone/other" }),
          ],
          ["/kept/demo"],
        ),
      ),
    ),
  );
});
