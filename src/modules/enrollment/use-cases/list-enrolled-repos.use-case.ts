import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type EnrolledRepoRoot } from "../domain/enrolled-repo/enrolled-repo.root.ts";
import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { EnrolledRepos, EnrolledRepoSummary } from "./enrolled-repos.result.ts";

const summaryOf = (repo: EnrolledRepoRoot) =>
  EnrolledRepoSummary.make({
    name: EnrolledRepoRootOps.nameOf(repo),
    repo: repo.repo,
    path: repo.path,
  });

// The repos a command acts on: the one a person names, or, with none named,
// every enrolled repo.
export const listEnrolledReposUseCase = Effect.fn("listEnrolledReposUseCase")(function* (
  name: Option.Option<string>,
) {
  const repos = yield* (yield* EnrolledReposRepository).findAll;

  if (Option.isNone(name)) {
    return EnrolledRepos.make({ repos: repos.map(summaryOf) });
  }

  return EnrolledRepos.make({
    repos: [summaryOf(yield* Effect.fromResult(EnrolledRepoRootOps.named(repos, name.value)))],
  });
});
