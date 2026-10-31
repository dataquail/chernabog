import * as Effect from "effect/Effect";

import { RunWaitSpecifications } from "../domain/run-wait/run-wait.specification.ts";
import { RunWait, RunWaits } from "../domain/run-wait/run-wait-view.value-object.ts";
import { RunWaitsRepository } from "../domain/run-wait/run-waits.repository.ts";
import { type ListRunWaitsPayload } from "./list-run-waits.query.ts";

export const listRunWaitsHandler = Effect.fn("listRunWaitsHandler")(function* ({
  runId,
  signal,
}: ListRunWaitsPayload) {
  const waits = yield* (yield* RunWaitsRepository).findMany(RunWaitSpecifications.forRun(runId));

  return RunWaits.make({
    waits: waits.filter((wait) => wait.signal === signal).map((wait) => RunWait.make({ ...wait })),
  });
});
