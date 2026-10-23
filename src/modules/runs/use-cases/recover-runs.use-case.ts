import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Result from "effect/Result";

import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { type RunAlreadyFinished } from "../domain/run/run.errors.ts";
import { type RunRoot } from "../domain/run/run.root.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RecoveredRuns, RunView } from "./run.result.ts";

const INTERRUPTED = "interrupted before its workflow started";

// Finishes the starts a crash interrupted. A run is recorded before its
// workflow executes, so a process killed in between leaves one running with no
// execution, which nothing polls and which holds its item. Its workflow
// executes now from the work item the run kept: an execution is keyed by its
// run, so one that did start before the crash is the one attached, not a
// second. A run with no item to execute ends, so its item can start again. A
// run whose flow this process didn't load is left for one that has.
export const recoverRunsUseCase = Effect.fn("recoverRunsUseCase")(function* () {
  const runs = yield* RunsRepository;
  const workflows = yield* WorkflowsClient;

  const interrupted = (yield* runs.findAll({ running: true })).flatMap((run) =>
    Option.toArray(RunRootOps.unexecuted(run)),
  );

  const executed: Array<RunView> = [];
  const abandoned: Array<RunView> = [];
  const left: Array<RunView> = [];

  // The ops can't fail here: every run recovered is still running.
  const saved = (change: Result.Result<RunRoot, RunAlreadyFinished>) =>
    Effect.fromResult(change).pipe(Effect.orDie, Effect.tap(runs.save));

  for (const run of interrupted) {
    if (Option.isNone(run.item)) {
      const ended = yield* saved(
        RunRootOps.finish(run, "failed", INTERRUPTED, DateTime.formatIso(yield* DateTime.now)),
      );

      abandoned.push(RunView.make({ ...ended }));
      continue;
    }

    const flow = { repo: run.repo, flow: run.flow, persona: run.persona };

    if (!workflows.runs(flow)) {
      left.push(RunView.make({ ...run }));
      continue;
    }

    const executionId = yield* workflows.execute(flow, run.id, run.item.value);

    const attached = yield* saved(RunRootOps.attachExecution(run, executionId));

    executed.push(RunView.make({ ...attached }));
  }

  return RecoveredRuns.make({ executed, abandoned, left });
});
