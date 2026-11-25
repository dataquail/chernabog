import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";

import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { SweptJournals } from "../domain/run/run-view.value-object.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";

export const sweepJournalsHandler = Effect.fn("sweepJournalsHandler")(function* () {
  const workflows = yield* WorkflowsClient;

  // Its read of state.db is its unit of work; the journals it deletes are
  // files no transaction covers, so it deletes them outside it.
  const running = yield* RunsRepository.use((runs) =>
    runs.findMany(RunSpecifications.running),
  ).pipe(withUnitOfWork, Effect.catchTag("PersistenceUnavailable", Effect.die));

  const live = new Set(running.map((run) => String(run.id)));
  const swept: Array<string> = [];

  // A journal whose run has ended is a reaction a crash lost: deleted now.
  for (const runId of yield* workflows.journals) {
    if (!live.has(runId)) {
      yield* workflows.discard(runId);
      swept.push(runId);
    }
  }

  return SweptJournals.make({ swept });
});
