import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { RunCleanupClient } from "../domain/ports/clients/run-cleanup.client.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { SweptContainers } from "../domain/run/run-view.value-object.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";

export const sweepContainersHandler = Effect.fn("sweepContainersHandler")(function* () {
  const cleanup = yield* RunCleanupClient;

  // Its read of state.db is its unit of work; the containers it removes are
  // no transaction's, so it removes them outside it.
  const running = yield* RunsRepository.use((runs) =>
    runs.findMany(RunSpecifications.running),
  ).pipe(withUnitOfWork, Effect.catchTag("PersistenceUnavailable", Effect.die));

  const live = new Set(running.map((run) => String(run.id)));
  const removed: Array<{ runtime: string; id: string; runId: string }> = [];
  const failed: Array<{ runtime: string; message: string }> = [];

  // Each runtime on its own: one that doesn't answer keeps none of the
  // others from their sweep.
  for (const runtime of yield* cleanup.containerRuntimes) {
    const listed = yield* cleanup.labelledContainers(runtime).pipe(Effect.result);

    if (Result.isFailure(listed)) {
      failed.push({ runtime, message: listed.failure.message });
      continue;
    }

    for (const container of listed.success) {
      if (live.has(container.runId) || container.launched) {
        continue;
      }

      const removing = yield* cleanup.removeContainer(container).pipe(Effect.result);

      if (Result.isFailure(removing)) {
        failed.push({ runtime, message: removing.failure.message });
      } else {
        removed.push({ runtime, id: container.id, runId: container.runId });
      }
    }
  }

  return SweptContainers.make({ removed, failed });
});
