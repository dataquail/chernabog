import { EventBus } from "@effect-server-utils/cqrs";
import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunNotFound } from "../domain/run/run.errors.ts";
import { RunEvents } from "../domain/run/run.events.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { type NameSubjectPayload } from "./name-subject.command.ts";

export const nameSubjectHandler = Effect.fn("nameSubjectHandler")(
  function* ({ runId, subject }: NameSubjectPayload) {
    const runs = yield* RunsRepository;
    const found = yield* runs.findOne(RunSpecifications.withId(runId));

    if (Option.isNone(found)) {
      return yield* new RunNotFound({ runId });
    }

    const changed = yield* Effect.fromResult(RunRootOps.nameSubject(found.value, subject));
    yield* runs.upsertOne(changed);

    // A subject it named before, as a resumed run names it again, went out the first time.
    if (!found.value.subjects.includes(subject)) {
      yield* (yield* EventBus).dispatch(
        Option.toArray(RunEvents.pullRequestOpened(changed, subject)),
      );
    }

    return RunView.make({ ...changed });
  },
  withUnitOfWork,
  // state.db is a file on this machine: it has no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
