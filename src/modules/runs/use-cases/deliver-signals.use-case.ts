import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import { RunWaitsRepository } from "../domain/ports/repositories/run-waits.repository.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { type FlowRef, type WorkItem } from "../domain/run/work-item.value-object.ts";
import { Delivered } from "./flow.result.ts";

// Wakes the persona's runs waiting on a signal its flow's trigger reported for
// their item, each wait once.
export const deliverSignalsUseCase = Effect.fn("deliverSignalsUseCase")(function* (
  flow: FlowRef,
  items: ReadonlyArray<WorkItem>,
) {
  const running = yield* (yield* RunsRepository).findAll({ running: true });
  const waits = yield* RunWaitsRepository;
  const workflows = yield* WorkflowsClient;
  let count = 0;

  for (const item of items) {
    const run = RunRootOps.activeFor(running, {
      repo: flow.repo,
      persona: flow.persona,
      flow: flow.flow,
      itemKey: item.key,
    });

    for (const active of Option.toArray(run)) {
      const parked = yield* waits.findAll(Option.some(active.id));

      for (const signal of item.signals ?? []) {
        for (const wait of parked.filter((one) => one.signal === signal)) {
          yield* workflows.wake(wait.deferred, wait.token);
          yield* waits.remove(wait);
          yield* workflows.note(wait.runId, `signal: ${signal}`);
          count += 1;
        }
      }
    }
  }

  return Delivered.make({ count });
});
