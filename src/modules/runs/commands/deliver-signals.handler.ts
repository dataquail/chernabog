import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import { RunWaitsRepository } from "../domain/ports/repositories/run-waits.repository.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunWaitRootOps } from "../domain/run-wait/run-wait.root-ops.ts";
import { Delivered } from "../domain/run-wait/run-wait-view.value-object.ts";
import { type DeliverSignalsPayload } from "./deliver-signals.command.ts";

export const deliverSignalsHandler = Effect.fn("deliverSignalsHandler")(function* ({
  flow,
  items,
}: DeliverSignalsPayload) {
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
      const done = new Set<string>();

      for (const signal of item.signals ?? []) {
        for (const wait of parked.filter((one) => one.signal === signal)) {
          if (done.has(wait.deferred)) {
            continue;
          }

          yield* workflows.wake(wait.deferred, wait.token);
          yield* waits.remove(wait);
          yield* workflows.note(wait.runId, `signal: ${signal}`);
          count += 1;
          done.add(wait.deferred);

          for (const lost of RunWaitRootOps.losersTo(wait, parked)) {
            yield* waits.remove(lost);
            done.add(lost.deferred);
          }
        }
      }
    }
  }

  return Delivered.make({ count });
});
