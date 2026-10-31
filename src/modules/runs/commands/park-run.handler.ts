import { EventBus } from "@effect-server-utils/cqrs";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunEvents } from "../domain/run/run.events.ts";
import { RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
import { RunWaitSpecifications } from "../domain/run-wait/run-wait.specification.ts";
import { RunWait } from "../domain/run-wait/run-wait-view.value-object.ts";
import { RunWaitsRepository } from "../domain/run-wait/run-waits.repository.ts";
import { type ParkRunPayload } from "./park-run.command.ts";

export const parkRunHandler = Effect.fn("parkRunHandler")(function* (parking: ParkRunPayload) {
  const waits = yield* RunWaitsRepository;
  const parkedAt = DateTime.formatIso(yield* DateTime.now);
  const wait = RunWaitRoot.make({ ...parking, parkedAt: Option.some(parkedAt) });

  // A resumed run registers its wait again, and that wait's event went out
  // the first time.
  const again = (yield* waits.findMany(RunWaitSpecifications.forRun(parking.runId))).some(
    (parked) => parked.deferred === parking.deferred,
  );

  yield* waits.upsertOne(wait);

  if (!again) {
    yield* (yield* EventBus).dispatch([
      RunEvents.needsAttention({
        runId: parking.runId,
        signal: parking.signal,
        deferred: parking.deferred,
        parkedAt,
      }),
    ]);
  }

  return RunWait.make({ ...wait });
});
