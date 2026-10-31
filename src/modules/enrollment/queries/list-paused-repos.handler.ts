import * as Effect from "effect/Effect";

import { EnrolledRepoSpecifications } from "../domain/enrolled-repo/enrolled-repo.specification.ts";
import { EnrolledReposRepository } from "../domain/enrolled-repo/enrolled-repos.repository.ts";
import { PausedRepos } from "./list-paused-repos.query.ts";

export const listPausedReposHandler = Effect.fn("listPausedReposHandler")(function* () {
  const repos = yield* (yield* EnrolledReposRepository).findMany(EnrolledRepoSpecifications.paused);

  return PausedRepos.make({ repos: repos.map((repo) => repo.repo) });
});
