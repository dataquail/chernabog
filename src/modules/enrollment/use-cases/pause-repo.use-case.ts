import * as Effect from "effect/Effect";

import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { PauseState } from "./pause-state.result.ts";

// Pauses the repo a person names: it starts no new runs, and the runs in flight continue.
export const pauseRepoUseCase = Effect.fn("pauseRepoUseCase")(function* (name: string) {
  const repository = yield* EnrolledReposRepository;
  const repo = yield* Effect.fromResult(EnrolledRepoRootOps.named(yield* repository.findAll, name));
  const paused = EnrolledRepoRootOps.pause(repo);
  yield* repository.save(paused);

  return PauseState.make({
    name: EnrolledRepoRootOps.nameOf(paused),
    repo: paused.repo,
    paused: paused.paused,
    changed: repo.paused !== paused.paused,
  });
});
