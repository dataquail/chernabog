import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { FoundRun, RunView } from "../domain/run/run-view.value-object.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { type ResumeRunPayload } from "./resume-run.command.ts";

// The unit of work around this command's reads and writes in state.db alone.
// What it asks of GitHub, git, a launcher or the engine stays outside it: a
// transaction holds state.db's one connection, which the engine's journal
// waits on (docs/adr/0010-commands-declare-their-unit-of-work.md).
const inUnitOfWork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    withUnitOfWork,
    // state.db is a file on this machine: it has no outage to wait out.
    Effect.catchTag("PersistenceUnavailable", Effect.die),
  );

export const resumeRunHandler = Effect.fn("resumeRunHandler")(function* ({
  runId,
}: ResumeRunPayload) {
  const found = yield* RunsRepository.use((runs) =>
    runs.findOne(RunSpecifications.withId(runId)),
  ).pipe(inUnitOfWork);

  const workflows = yield* WorkflowsClient;

  for (const run of Option.toArray(Option.filter(found, RunRootOps.isRunning))) {
    for (const executionId of Option.toArray(run.executionId)) {
      yield* workflows.resume(
        { repo: run.repo, flow: run.flow, persona: run.persona },
        executionId,
      );
    }
  }

  return FoundRun.make({ run: Option.map(found, (run) => RunView.make({ ...run })) });
});
