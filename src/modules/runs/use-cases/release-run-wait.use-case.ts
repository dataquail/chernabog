import * as Effect from "effect/Effect";

import { RunWaitsRepository } from "../domain/ports/repositories/run-waits.repository.ts";
import { RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
import { type RunWait } from "./run-wait.result.ts";

// Forgets a wait once its signal has woken the run.
export const releaseRunWaitUseCase = Effect.fn("releaseRunWaitUseCase")(function* (wait: RunWait) {
  yield* (yield* RunWaitsRepository).remove(RunWaitRoot.make({ ...wait }));

  return wait;
});
