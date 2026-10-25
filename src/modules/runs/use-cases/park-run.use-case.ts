import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

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
// review's pull request. A parked run holds no slot until it wakes. The wait
// keeps when it parked, for a person to see how long it has waited.
export const parkRunUseCase = Effect.fn("parkRunUseCase")(function* (parking: Parking) {
  const wait = RunWaitRoot.make({
    ...parking,
    parkedAt: Option.some(DateTime.formatIso(yield* DateTime.now)),
  });

  yield* (yield* RunWaitsRepository).save(wait);

  return RunWait.make({ ...wait });
});
