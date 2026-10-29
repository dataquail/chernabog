import * as Effect from "effect/Effect";

import { type Persona } from "../../../kernel/persona.value-object.ts";
import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { EnrolledRepoSummary } from "./enrolled-repos.result.ts";

// Turns one flow on or off for a persona of the repo a person names. A flow
// turned off keeps its settings, as enabled: false.
export const setPersonaFlowUseCase = Effect.fn("setPersonaFlowUseCase")(function* (
  name: string,
  persona: Persona,
  flow: string,
  enabled: boolean,
) {
  const repository = yield* EnrolledReposRepository;
  const repo = yield* Effect.fromResult(EnrolledRepoRootOps.named(yield* repository.findAll, name));
  yield* repository.save(EnrolledRepoRootOps.setFlow(repo, persona, flow, enabled));

  return EnrolledRepoSummary.make({
    name: EnrolledRepoRootOps.nameOf(repo),
    repo: repo.repo,
    path: repo.path,
  });
});
