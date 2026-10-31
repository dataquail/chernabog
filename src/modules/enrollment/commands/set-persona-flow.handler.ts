import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";

import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledRepoSummary } from "../domain/enrolled-repo/enrolled-repo-summary.value-object.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { type SetPersonaFlowPayload } from "./set-persona-flow.command.ts";

export const setPersonaFlowHandler = Effect.fn("setPersonaFlowHandler")(
  function* (cmd: SetPersonaFlowPayload) {
    const repository = yield* EnrolledReposRepository;

    const repo = yield* Effect.fromResult(
      EnrolledRepoRootOps.named(yield* repository.findAll, cmd.name),
    );

    yield* repository.save(EnrolledRepoRootOps.setFlow(repo, cmd.persona, cmd.flow, cmd.enabled));

    return EnrolledRepoSummary.make({
      name: EnrolledRepoRootOps.nameOf(repo),
      repo: repo.repo,
      path: repo.path,
    });
  },
  withUnitOfWork,
  // Its stores are files on this machine: they have no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
