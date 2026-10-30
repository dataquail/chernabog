import * as Effect from "effect/Effect";

import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { PausedRepos } from "./list-paused-repos.query.ts";

export const listPausedReposHandler = Effect.fn("listPausedReposHandler")(function* () {
  const repos = yield* (yield* EnrolledReposRepository).findAll;

  return PausedRepos.make({ repos: repos.filter((repo) => repo.paused).map((repo) => repo.repo) });
});
