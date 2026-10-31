import { EventBus } from "@effect-server-utils/cqrs";
import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunWaitsRepository } from "../domain/ports/repositories/run-waits.repository.ts";
import { RunEvents } from "../domain/run/run.events.ts";
import { RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
import { RunWait } from "../domain/run-wait/run-wait-view.value-object.ts";
import { type ParkRunPayload } from "./park-run.command.ts";

export const parkRunHandler = Effect.fn("parkRunHandler")(
  function* (parking: ParkRunPayload) {
    const waits = yield* RunWaitsRepository;
    const parkedAt = DateTime.formatIso(yield* DateTime.now);
    const wait = RunWaitRoot.make({ ...parking, parkedAt: Option.some(parkedAt) });

    // A resumed run registers its wait again, and that wait's event went out
    // the first time.
    const again = (yield* waits.findAll(Option.some(parking.runId))).some(
      (parked) => parked.deferred === parking.deferred,
    );

    yield* waits.save(wait);

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
  },
  withUnitOfWork,
  // state.db is a file on this machine: it has no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
