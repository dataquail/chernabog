import { EventBus } from "@effect-server-utils/cqrs";
import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { EnrollmentEvents } from "../domain/enrolled-repo/enrolled-repo.events.ts";
import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledRepoSummary } from "../domain/enrolled-repo/enrolled-repo-summary.value-object.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { type UnenrollRepoPayload } from "./unenroll-repo.command.ts";

export const unenrollRepoHandler = Effect.fn("unenrollRepoHandler")(
  function* (cmd: UnenrollRepoPayload) {
    const repository = yield* EnrolledReposRepository;

    const repo = yield* Effect.fromResult(
      EnrolledRepoRootOps.named(yield* repository.findAll, cmd.name),
    );

    yield* repository.remove(repo);
    yield* (yield* EventBus).dispatch([
      EnrollmentEvents.unenrolled(repo, DateTime.formatIso(yield* DateTime.now)),
    ]);

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
