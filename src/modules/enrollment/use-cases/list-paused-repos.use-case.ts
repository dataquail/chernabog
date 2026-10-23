import * as Effect from 'effect/Effect';

import { EnrolledReposRepository } from '../domain/ports/repositories/enrolled-repos.repository.ts';
import { PausedRepos } from './paused-repos.result.ts';

// The enrolled repos that are paused now, which the daemon starts nothing in.
export const listPausedReposUseCase = Effect.fn('listPausedReposUseCase')(function* () {
  const repos = yield* (yield* EnrolledReposRepository).findAll;

  return PausedRepos.make({ repos: repos.filter((repo) => repo.paused).map((repo) => repo.repo) });
});
