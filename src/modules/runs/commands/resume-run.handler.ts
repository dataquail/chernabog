import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { FoundRun, RunView } from "../domain/run/run-view.value-object.ts";
import { type ResumeRunPayload } from "./resume-run.command.ts";

export const resumeRunHandler = Effect.fn("resumeRunHandler")(function* ({
  runId,
}: ResumeRunPayload) {
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
