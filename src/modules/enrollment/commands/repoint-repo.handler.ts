import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";

import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledRepoSummary } from "../domain/enrolled-repo/enrolled-repo-summary.value-object.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { type RepointRepoPayload } from "./repoint-repo.command.ts";

export const repointRepoHandler = Effect.fn("repointRepoHandler")(
  function* (cmd: RepointRepoPayload) {
    const repository = yield* EnrolledReposRepository;

    const repo = yield* Effect.fromResult(
      EnrolledRepoRootOps.named(yield* repository.findAll, cmd.name),
    );

    const moved = EnrolledRepoRootOps.repoint(repo, cmd.root);
    yield* repository.save(moved);

    return EnrolledRepoSummary.make({
      name: EnrolledRepoRootOps.nameOf(moved),
      repo: moved.repo,
      path: moved.path,
    });
  },
  withUnitOfWork,
  // Its stores are files on this machine: they have no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
