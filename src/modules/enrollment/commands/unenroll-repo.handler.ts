import * as Effect from "effect/Effect";

import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledRepoSummary } from "../domain/enrolled-repo/enrolled-repo-summary.value-object.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { type UnenrollRepoPayload } from "./unenroll-repo.command.ts";

export const unenrollRepoHandler = Effect.fn("unenrollRepoHandler")(function* (
  cmd: UnenrollRepoPayload,
) {
  const repository = yield* EnrolledReposRepository;

  const repo = yield* Effect.fromResult(
    EnrolledRepoRootOps.named(yield* repository.findAll, cmd.name),
  );

  yield* repository.remove(repo);

  return EnrolledRepoSummary.make({
    name: EnrolledRepoRootOps.nameOf(repo),
    repo: repo.repo,
    path: repo.path,
  });
});
