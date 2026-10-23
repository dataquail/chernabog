import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { FoundRun, RunView } from "./run.result.ts";

// Resumes a run in flight whose workflow a restart suspended, so it goes on
// from its journal. A run that ended, or never got an execution, is left as is.
export const resumeRunUseCase = Effect.fn("resumeRunUseCase")(function* (runId: RunId) {
  const found = yield* (yield* RunsRepository).findOne(runId);
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
