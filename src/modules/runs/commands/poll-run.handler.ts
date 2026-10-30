import { EventBus } from "@effect-server-utils/cqrs";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunEvents } from "../domain/run/run.events.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { FoundRun, RunView } from "../domain/run/run-view.value-object.ts";
import { type PollRunPayload } from "./poll-run.command.ts";

export const pollRunHandler = Effect.fn("pollRunHandler")(function* ({ runId }: PollRunPayload) {
  const runs = yield* RunsRepository;
  const workflows = yield* WorkflowsClient;
  const found = Option.filter(yield* runs.findOne(runId), RunRootOps.isRunning);

  for (const run of Option.toArray(found)) {
    for (const executionId of Option.toArray(run.executionId)) {
      const outcome = yield* workflows.poll(
        { repo: run.repo, flow: run.flow, persona: run.persona },
        executionId,
      );

      for (const ended of Option.toArray(outcome)) {
        const finished = RunRootOps.finish(
          run,
          ended.status,
          ended.summary,
          DateTime.formatIso(yield* DateTime.now),
        );

        // A run another poll ended first stays as that one ended it.
        if (Result.isSuccess(finished)) {
          yield* runs.save(finished.success);
          yield* (yield* EventBus).dispatch(Option.toArray(RunEvents.finished(finished.success)));
        }
      }
    }
  }

  return FoundRun.make({
    run: Option.map(yield* runs.findOne(runId), (run) => RunView.make({ ...run })),
  });
});
