import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunWaitsRepository } from "../domain/ports/repositories/run-waits.repository.ts";
import { RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
import { RunWait } from "../domain/run-wait/run-wait-view.value-object.ts";
import { type ParkRunPayload } from "./park-run.command.ts";

export const parkRunHandler = Effect.fn("parkRunHandler")(function* (parking: ParkRunPayload) {
  const wait = RunWaitRoot.make({
    ...parking,
    parkedAt: Option.some(DateTime.formatIso(yield* DateTime.now)),
  });

  yield* (yield* RunWaitsRepository).save(wait);

  return RunWait.make({ ...wait });
});
