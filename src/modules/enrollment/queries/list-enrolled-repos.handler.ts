import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type EnrolledRepoRoot } from "../domain/enrolled-repo/enrolled-repo.root.ts";
import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledRepoSummary } from "../domain/enrolled-repo/enrolled-repo-summary.value-object.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { EnrolledRepos, type ListEnrolledReposPayload } from "./list-enrolled-repos.query.ts";

const summaryOf = (repo: EnrolledRepoRoot) =>
  EnrolledRepoSummary.make({
    name: EnrolledRepoRootOps.nameOf(repo),
    repo: repo.repo,
    path: repo.path,
  });

export const listEnrolledReposHandler = Effect.fn("listEnrolledReposHandler")(function* (
  query: ListEnrolledReposPayload,
) {
  const repos = yield* (yield* EnrolledReposRepository).findAll;

  if (Option.isNone(query.name)) {
    return EnrolledRepos.make({ repos: repos.map(summaryOf) });
  }

  return EnrolledRepos.make({
    repos: [
      summaryOf(yield* Effect.fromResult(EnrolledRepoRootOps.named(repos, query.name.value))),
    ],
  });
});
