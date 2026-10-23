import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { RunWaitsRepository } from "../domain/ports/repositories/run-waits.repository.ts";
import { RunWait, RunWaits } from "./run-wait.result.ts";

// What a run waits on for one signal: the deferreds the signal wakes.
export const listRunWaitsUseCase = Effect.fn("listRunWaitsUseCase")(function* (
  runId: RunId,
  signal: string,
) {
  const waits = yield* (yield* RunWaitsRepository).findAll(Option.some(runId));

  return RunWaits.make({
    waits: waits.filter((wait) => wait.signal === signal).map((wait) => RunWait.make({ ...wait })),
  });
});
