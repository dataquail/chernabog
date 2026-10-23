import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { CheckoutsClient } from "../domain/ports/clients/checkouts.client.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { MovedRepo, MovedRepos } from "./enrollment.result.ts";

// Entries of the repo a checkout is of whose checkout is gone: what a person
// setting up a checkout at its new place may point there. None for a checkout
// that isn't of a GitHub repo.
export const listMovedReposUseCase = Effect.fn("listMovedReposUseCase")(function* (root: string) {
  const checkouts = yield* CheckoutsClient;
  const checkout = yield* Effect.option(checkouts.inspect(root));

  if (Option.isNone(checkout)) {
    return MovedRepos.make({ repos: [] });
  }

  const repos = (yield* (yield* EnrolledReposRepository).findAll).filter(
    (repo) => repo.repo === checkout.value.repo && repo.path !== root,
  );

  const gone: Array<string> = [];

  for (const repo of repos) {
    if (!(yield* checkouts.exists(repo.path))) {
      gone.push(repo.path);
    }
  }

  return MovedRepos.make({
    repos: EnrolledRepoRootOps.moved(
      repos,
      checkout.value.repo,
      root,
      (path) => !gone.includes(path),
    ).map((repo) =>
      MovedRepo.make({
        name: EnrolledRepoRootOps.nameOf(repo),
        named: Option.fromUndefinedOr(repo.name),
        repo: repo.repo,
        path: repo.path,
      }),
    ),
  });
});
