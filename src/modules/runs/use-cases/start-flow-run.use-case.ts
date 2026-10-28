import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { RunId } from "../../../kernel/run-id.id.ts";
import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { type RunRoot } from "../domain/run/run.root.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { type FlowRef, type WorkItem } from "../domain/run/work-item.value-object.ts";
import { StartedRun } from "./flow.result.ts";
import { RunView } from "./run.result.ts";

// A run's id says nothing about it: its record says what it runs, and as whom.
// Random rather than time-ordered, so a few characters of it name a run.
const newRunId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()).pipe(
  Effect.map(RunId.make),
  Effect.orDie,
);

// Starts one run of a persona's flow for one work item, unless the persona
// already has one in flight for it: then that one is the run. An item
// reported only to wake a run starts none.
export const startFlowRunUseCase = Effect.fn("startFlowRunUseCase")(function* (
  flow: FlowRef,
  item: WorkItem,
) {
  const runs = yield* RunsRepository;
  const workflows = yield* WorkflowsClient;
  const wanted = { repo: flow.repo, persona: flow.persona, flow: flow.flow, itemKey: item.key };
  const running = yield* runs.findAll({ running: true });

  // The run already in flight, as it's stored now.
  const existing = (found: Option.Option<{ readonly id: RunId }>) =>
    Option.match(found, {
      onNone: () => Effect.succeed(Option.none<RunRoot>()),
      onSome: (one) => runs.findOne(one.id),
    }).pipe(
      Effect.map((run) =>
        StartedRun.make({
          run: Option.map(run, (one) => RunView.make({ ...one })),
          started: false,
        }),
      ),
    );

  if (item.wakeOnly === true) {
    return yield* existing(RunRootOps.activeFor(running, wanted));
  }

  const started = RunRootOps.start(
    running,
    {
      ...wanted,
      id: yield* newRunId,
      coreVersion: workflows.coreVersion,
      configTree: workflows.treeOf(flow),
      itemTitle: Option.fromUndefinedOr(item.title),
      itemUrl: Option.fromUndefinedOr(item.url),
      item: Option.some(item),
    },
    DateTime.formatIso(yield* DateTime.now),
  );

  if (Result.isFailure(started)) {
    return yield* existing(Option.some({ id: started.failure.runId }));
  }

  yield* runs.save(started.success);

  const executionId = yield* workflows.execute(flow, started.success.id, item);

  // The run can't have ended yet: nothing polls it before it has an execution.
  const attached = yield* Effect.fromResult(
    RunRootOps.attachExecution(started.success, executionId),
  ).pipe(Effect.orDie);

  yield* runs.save(attached);

  return StartedRun.make({ run: Option.some(RunView.make({ ...attached })), started: true });
});
