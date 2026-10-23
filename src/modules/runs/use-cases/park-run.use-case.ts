import * as Effect from "effect/Effect";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { RunWaitsRepository } from "../domain/ports/repositories/run-waits.repository.ts";
import { RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
import { RunWait } from "./run-wait.result.ts";

// What a run waits on: the signal, and the durable deferred and token that wake it.
export type Parking = {
  readonly runId: RunId;
  readonly signal: string;
  readonly deferred: string;
  readonly token: string;
};

// Parks a run on a signal its flow's trigger will report, such as a push to a
// review's pull request. A parked run holds no slot until it wakes.
export const parkRunUseCase = Effect.fn("parkRunUseCase")(function* (parking: Parking) {
  const wait = RunWaitRoot.make(parking);
  yield* (yield* RunWaitsRepository).save(wait);

  return RunWait.make({ ...wait });
});
