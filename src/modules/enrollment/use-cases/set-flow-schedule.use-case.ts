import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type Persona } from "../../../kernel/persona.value-object.ts";
import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { EnrolledRepoSummary } from "./enrolled-repos.result.ts";

// Overrides a flow's schedule for a persona of the repo a person names, or,
// with none, clears the override so the team's applies again. Refused, with
// nothing written, when the schedule isn't a cron expression.
export const setFlowScheduleUseCase = Effect.fn("setFlowScheduleUseCase")(function* (
  name: string,
  persona: Persona,
  flow: string,
  schedule: Option.Option<string>,
) {
  const repository = yield* EnrolledReposRepository;
  const repo = yield* Effect.fromResult(EnrolledRepoRootOps.named(yield* repository.findAll, name));
  const checked = yield* Effect.fromResult(EnrolledRepoRootOps.checkSchedule(schedule));
  yield* repository.save(EnrolledRepoRootOps.setFlowSchedule(repo, persona, flow, checked));

  return EnrolledRepoSummary.make({
    name: EnrolledRepoRootOps.nameOf(repo),
    repo: repo.repo,
    path: repo.path,
    baseBranch: EnrolledRepoRootOps.baseBranchOf(repo),
  });
});
