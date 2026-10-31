// What reacts to what happens to a run: each subscription to the events the
// runs' commands dispatch (run.events.ts), registered on the bus the root
// provides when the module's `events` slot is built (docs/adr/0013-event-handlers.md).
//
// Each is after commit, under a stable name: it reacts to an ending that is
// already in state.db, outside any transaction, and its failure undoes
// nothing. None needs to roll its publisher back, so none is immediate.

import { EventBus } from "@effect-server-utils/cqrs";
import { type UnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { type FlowsClient } from "../../domain/ports/clients/flows.client.ts";
import { RunFinished } from "../../domain/run/run.events.ts";
import { type RunsRepository } from "../../domain/run/runs.repository.ts";
import { type RunMarkersRepository } from "../../domain/run-marker/run-markers.repository.ts";
import { releaseRunMarkersHandler } from "../release-run-markers.handler.ts";

export const RunTriggersLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* EventBus;

    // What the handlers need, from the module that built this slot rather
    // than from whichever fiber committed the ending.
    const own = yield* Effect.context<
      EventBus | FlowsClient | RunMarkersRepository | RunsRepository | UnitOfWork
    >();

    // An ended run lets go of what it held at once (release-run-markers).
    yield* bus.subscribeAfterCommit(
      RunFinished,
      (event) => releaseRunMarkersHandler(event).pipe(Effect.provideContext(own)),
      { name: "runs/release-run-markers" },
    );
  }),
);
