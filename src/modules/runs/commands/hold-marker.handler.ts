import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunMarkerRootOps } from "../domain/run-marker/run-marker.root-ops.ts";
import { RunMarkerSpecifications } from "../domain/run-marker/run-marker.specification.ts";
import { RunMarkerView } from "../domain/run-marker/run-marker-view.value-object.ts";
import { RunMarkersRepository } from "../domain/run-marker/run-markers.repository.ts";
import { type HoldMarkerPayload } from "./hold-marker.command.ts";

export const holdMarkerHandler = Effect.fn("holdMarkerHandler")(
  function* (holding: HoldMarkerPayload) {
    const markers = yield* RunMarkersRepository;

    const existing = Option.fromUndefinedOr(
      (yield* markers.findMany(RunMarkerSpecifications.forRun(holding.runId))).find((marker) =>
        RunMarkerRootOps.same(marker, holding),
      ),
    );

    const held = RunMarkerRootOps.holdAgain(
      existing,
      holding,
      DateTime.formatIso(yield* DateTime.now),
    );

    for (const marker of Option.toArray(held)) {
      yield* markers.upsertOne(marker);
    }

    return RunMarkerView.make({ ...Option.getOrThrow(Option.orElse(held, () => existing)) });
  },
  withUnitOfWork,
  // state.db is a file on this machine: it has no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
