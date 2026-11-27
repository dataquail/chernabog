import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { RunId } from "../../../kernel/run-id.id.ts";
import { Spec } from "../../../kernel/specification.ts";
import {
  type LabelledContainer,
  RunCleanupClient,
} from "../domain/ports/clients/run-cleanup.client.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { SweptContainers } from "../domain/run/run-view.value-object.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";

// The runs among these ids that state.db records as ended. A run it has no
// row for isn't one: the labels don't name a home, so it may be another
// chernabog home's on the same runtime, still in flight.
const endedAmong = (runIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (runIds.length === 0) {
      return new Set<string>();
    }

    const ended = yield* RunsRepository.use((runs) =>
      runs.findMany(
        Spec.and(
          Spec.not(RunSpecifications.running),
          Spec.or(...runIds.map((id) => RunSpecifications.withId(RunId.make(id)))),
        ),
      ),
    ).pipe(withUnitOfWork, Effect.catchTag("PersistenceUnavailable", Effect.die));

    return new Set(ended.map((run) => String(run.id)));
  });

export const sweepContainersHandler = Effect.fn("sweepContainersHandler")(function* () {
  const cleanup = yield* RunCleanupClient;

  const listed: Array<LabelledContainer> = [];
  const removed: Array<{ runtime: string; id: string; runId: string }> = [];
  const failed: Array<{ runtime: string; message: string }> = [];

  // Each runtime on its own: one that doesn't answer keeps none of the
  // others from their sweep.
  for (const runtime of yield* cleanup.containerRuntimes) {
    const listing = yield* cleanup.labelledContainers(runtime).pipe(Effect.result);

    if (Result.isFailure(listing)) {
      failed.push({ runtime, message: listing.failure.message });
    } else {
      for (const container of listing.success) {
        listed.push(container);
      }
    }
  }

  // Its read of state.db is its unit of work; the containers it removes are
  // no transaction's, so it removes them outside it.
  const ended = yield* endedAmong([...new Set(listed.map((container) => container.runId))]);

  for (const container of listed) {
    if (!ended.has(container.runId) || container.launched) {
      continue;
    }

    const removing = yield* cleanup.removeContainer(container).pipe(Effect.result);

    if (Result.isFailure(removing)) {
      failed.push({ runtime: container.runtime, message: removing.failure.message });
    } else {
      removed.push({ runtime: container.runtime, id: container.id, runId: container.runId });
    }
  }

  return SweptContainers.make({ removed, failed });
});
