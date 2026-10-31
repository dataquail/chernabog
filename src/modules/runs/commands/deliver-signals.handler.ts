import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { RunWaitRootOps } from "../domain/run-wait/run-wait.root-ops.ts";
import { RunWaitSpecifications } from "../domain/run-wait/run-wait.specification.ts";
import { Delivered } from "../domain/run-wait/run-wait-view.value-object.ts";
import { RunWaitsRepository } from "../domain/run-wait/run-waits.repository.ts";
import { type DeliverSignalsPayload } from "./deliver-signals.command.ts";

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

export const deliverSignalsHandler = Effect.fn("deliverSignalsHandler")(function* ({
  flow,
  items,
}: DeliverSignalsPayload) {
  const running = yield* (yield* RunsRepository).findMany(RunSpecifications.running);
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
      const parked = yield* waits.findMany(RunWaitSpecifications.forRun(active.id));
      const done = new Set<string>();

      for (const signal of item.signals ?? []) {
        for (const wait of parked.filter((one) => one.signal === signal)) {
          if (done.has(wait.deferred)) {
            continue;
          }

          yield* workflows.wake(wait.deferred, wait.token);

          const losers = RunWaitRootOps.losersTo(wait, parked);

          yield* Effect.forEach([wait, ...losers], waits.deleteOne, { discard: true }).pipe(
            inUnitOfWork,
          );

          yield* workflows.note(wait.runId, `signal: ${signal}`);
          count += 1;

          for (const gone of [wait, ...losers]) {
            done.add(gone.deferred);
          }
        }
      }
    }
  }

  return Delivered.make({ count });
});
