import * as Effect from "effect/Effect";

import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledRepoSpecifications } from "../domain/enrolled-repo/enrolled-repo.specification.ts";
import { EnrolledRepoSummary } from "../domain/enrolled-repo/enrolled-repo-summary.value-object.ts";
import { EnrolledReposRepository } from "../domain/enrolled-repo/enrolled-repos.repository.ts";
import { type SetPersonaFlowPayload } from "./set-persona-flow.command.ts";

export const setPersonaFlowHandler = Effect.fn("setPersonaFlowHandler")(function* (
  cmd: SetPersonaFlowPayload,
) {
  const repository = yield* EnrolledReposRepository;

  const repo = yield* Effect.fromResult(
    EnrolledRepoRootOps.named(yield* repository.findMany(EnrolledRepoSpecifications.all), cmd.name),
  );

  yield* repository.upsertOne(
    EnrolledRepoRootOps.setFlow(repo, cmd.persona, cmd.flow, cmd.enabled),
  );

  return EnrolledRepoSummary.make({
    name: EnrolledRepoRootOps.nameOf(repo),
    repo: repo.repo,
    path: repo.path,
  });
});
