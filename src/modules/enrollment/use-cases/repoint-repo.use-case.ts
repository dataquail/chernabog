import * as Effect from "effect/Effect";

import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { EnrolledRepoSummary } from "./enrolled-repos.result.ts";

// Points the entry a person names at its checkout's new place, keeping every
// setting.
export const repointRepoUseCase = Effect.fn("repointRepoUseCase")(function* (
  name: string,
  root: string,
) {
  const repository = yield* EnrolledReposRepository;
  const repo = yield* Effect.fromResult(EnrolledRepoRootOps.named(yield* repository.findAll, name));
  const moved = EnrolledRepoRootOps.repoint(repo, root);
  yield* repository.save(moved);

  return EnrolledRepoSummary.make({
    name: EnrolledRepoRootOps.nameOf(moved),
    repo: moved.repo,
    path: moved.path,
    baseBranch: EnrolledRepoRootOps.baseBranchOf(moved),
  });
});
