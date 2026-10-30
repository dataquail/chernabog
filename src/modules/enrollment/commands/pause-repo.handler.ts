import * as Effect from "effect/Effect";

import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { type PauseRepoPayload, PauseState } from "./pause-repo.command.ts";

export const pauseRepoHandler = Effect.fn("pauseRepoHandler")(function* (cmd: PauseRepoPayload) {
  const repository = yield* EnrolledReposRepository;

  const repo = yield* Effect.fromResult(
    EnrolledRepoRootOps.named(yield* repository.findAll, cmd.name),
  );

  const paused = EnrolledRepoRootOps.pause(repo);
  yield* repository.save(paused);

  return PauseState.make({
    name: EnrolledRepoRootOps.nameOf(paused),
    repo: paused.repo,
    paused: paused.paused,
    changed: repo.paused !== paused.paused,
  });
});
