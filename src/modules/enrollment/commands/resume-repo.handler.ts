import { EventBus } from "@effect-server-utils/cqrs";
import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { EnrollmentEvents } from "../domain/enrolled-repo/enrolled-repo.events.ts";
import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledRepoSpecifications } from "../domain/enrolled-repo/enrolled-repo.specification.ts";
import { EnrolledReposRepository } from "../domain/enrolled-repo/enrolled-repos.repository.ts";
import { PauseState } from "./pause-repo.command.ts";
import { type ResumeRepoPayload } from "./resume-repo.command.ts";

export const resumeRepoHandler = Effect.fn("resumeRepoHandler")(
  function* (cmd: ResumeRepoPayload) {
    const repository = yield* EnrolledReposRepository;

    const repo = yield* Effect.fromResult(
      EnrolledRepoRootOps.named(
        yield* repository.findMany(EnrolledRepoSpecifications.all),
        cmd.name,
      ),
    );

    const resumed = EnrolledRepoRootOps.resume(repo);
    yield* repository.upsertOne(resumed);
    yield* (yield* EventBus).dispatch(
      EnrollmentEvents.pausedOrResumed(repo, resumed, DateTime.formatIso(yield* DateTime.now)),
    );

    return PauseState.make({
      name: EnrolledRepoRootOps.nameOf(resumed),
      repo: resumed.repo,
      paused: resumed.paused,
      changed: repo.paused !== resumed.paused,
    });
  },
  withUnitOfWork,
  // Its stores are files on this machine: they have no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
