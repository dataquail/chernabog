import * as Effect from "effect/Effect";

import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledRepoSpecifications } from "../domain/enrolled-repo/enrolled-repo.specification.ts";
import { EnrolledRepoSummary } from "../domain/enrolled-repo/enrolled-repo-summary.value-object.ts";
import { EnrolledReposRepository } from "../domain/enrolled-repo/enrolled-repos.repository.ts";
import { type SetFlowSchedulePayload } from "./set-flow-schedule.command.ts";

export const setFlowScheduleHandler = Effect.fn("setFlowScheduleHandler")(function* (
  cmd: SetFlowSchedulePayload,
) {
  const repository = yield* EnrolledReposRepository;

  const repo = yield* Effect.fromResult(
    EnrolledRepoRootOps.named(yield* repository.findMany(EnrolledRepoSpecifications.all), cmd.name),
  );

  const checked = yield* Effect.fromResult(EnrolledRepoRootOps.checkSchedule(cmd.schedule));
  yield* repository.upsertOne(
    EnrolledRepoRootOps.setFlowSchedule(repo, cmd.persona, cmd.flow, checked),
  );

  return EnrolledRepoSummary.make({
    name: EnrolledRepoRootOps.nameOf(repo),
    repo: repo.repo,
    path: repo.path,
  });
});
