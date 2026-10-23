import * as Effect from 'effect/Effect';

import { EnrolledRepoRootOps } from '../domain/enrolled-repo/enrolled-repo.root-ops.ts';
import { EnrolledReposRepository } from '../domain/ports/repositories/enrolled-repos.repository.ts';
import { PauseState } from './pause-state.result.ts';

// Lets the paused repo a person names start runs again.
export const resumeRepoUseCase = Effect.fn('resumeRepoUseCase')(function* (name: string) {
  const repository = yield* EnrolledReposRepository;
  const repo = yield* Effect.fromResult(EnrolledRepoRootOps.named(yield* repository.findAll, name));
  const resumed = EnrolledRepoRootOps.resume(repo);
  yield* repository.save(resumed);

  return PauseState.make({ name: EnrolledRepoRootOps.nameOf(resumed), repo: resumed.repo, paused: resumed.paused, changed: repo.paused !== resumed.paused });
});
