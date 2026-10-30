import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunWaitsRepository } from "../domain/ports/repositories/run-waits.repository.ts";
import { RunWait } from "../domain/run-wait/run-wait-view.value-object.ts";
import { type ListRunWaitsPayload, RunWaits } from "./list-run-waits.query.ts";

export const listRunWaitsHandler = Effect.fn("listRunWaitsHandler")(function* ({
  runId,
  signal,
}: ListRunWaitsPayload) {
  const waits = yield* (yield* RunWaitsRepository).findAll(Option.some(runId));

  return RunWaits.make({
    waits: waits.filter((wait) => wait.signal === signal).map((wait) => RunWait.make({ ...wait })),
  });
});
