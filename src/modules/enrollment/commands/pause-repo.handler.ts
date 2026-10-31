import { EventBus } from "@effect-server-utils/cqrs";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { EnrollmentEvents } from "../domain/enrolled-repo/enrolled-repo.events.ts";
import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledRepoSpecifications } from "../domain/enrolled-repo/enrolled-repo.specification.ts";
import { EnrolledReposRepository } from "../domain/enrolled-repo/enrolled-repos.repository.ts";
import { type PauseRepoPayload, PauseState } from "./pause-repo.command.ts";

export const pauseRepoHandler = Effect.fn("pauseRepoHandler")(function* (cmd: PauseRepoPayload) {
  const repository = yield* EnrolledReposRepository;

  const repo = yield* Effect.fromResult(
    EnrolledRepoRootOps.named(yield* repository.findMany(EnrolledRepoSpecifications.all), cmd.name),
  );

  const paused = EnrolledRepoRootOps.pause(repo);
  yield* repository.upsertOne(paused);
  yield* (yield* EventBus).dispatch(
    EnrollmentEvents.pausedOrResumed(repo, paused, DateTime.formatIso(yield* DateTime.now)),
  );

  return PauseState.make({
    name: EnrolledRepoRootOps.nameOf(paused),
    repo: paused.repo,
    paused: paused.paused,
    changed: repo.paused !== paused.paused,
  });
});
