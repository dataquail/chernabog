import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Spec } from "../../../kernel/specification.ts";
import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledRepoSpecifications } from "../domain/enrolled-repo/enrolled-repo.specification.ts";
import { EnrolledReposRepository } from "../domain/enrolled-repo/enrolled-repos.repository.ts";
import { CheckoutsClient } from "../domain/ports/clients/checkouts.client.ts";
import { type ListMovedReposPayload, MovedRepo, MovedRepos } from "./list-moved-repos.query.ts";

export const listMovedReposHandler = Effect.fn("listMovedReposHandler")(function* (
  query: ListMovedReposPayload,
) {
  const { root } = query;
  const checkouts = yield* CheckoutsClient;
  const checkout = yield* Effect.option(checkouts.inspect(root));

  if (Option.isNone(checkout)) {
    return MovedRepos.make({ repos: [] });
  }

  const repos = yield* (yield* EnrolledReposRepository).findMany(
    Spec.and(
      EnrolledRepoSpecifications.forRepo(checkout.value.repo),
      Spec.not(EnrolledRepoSpecifications.atPath(root)),
    ),
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
