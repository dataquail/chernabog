import * as Effect from "effect/Effect";

import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { EnrolledRepoSummary } from "./enrolled-repos.result.ts";

// Removes the repo a person names from this machine, settings and all.
export const unenrollRepoUseCase = Effect.fn("unenrollRepoUseCase")(function* (name: string) {
  const repository = yield* EnrolledReposRepository;
  const repo = yield* Effect.fromResult(EnrolledRepoRootOps.named(yield* repository.findAll, name));
  yield* repository.remove(repo);

  return EnrolledRepoSummary.make({
    name: EnrolledRepoRootOps.nameOf(repo),
    repo: repo.repo,
    path: repo.path,
    baseBranch: EnrolledRepoRootOps.baseBranchOf(repo),
  });
});
