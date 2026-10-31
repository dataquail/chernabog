import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";

import { RunMarkerRootOps } from "../domain/run-marker/run-marker.root-ops.ts";
import { RunMarkerSpecifications } from "../domain/run-marker/run-marker.specification.ts";
import { RunMarkersRepository } from "../domain/run-marker/run-markers.repository.ts";
import { type ForgetMarkerPayload } from "./forget-marker.command.ts";

export const forgetMarkerHandler = Effect.fn("forgetMarkerHandler")(
  function* ({ args, name, runId }: ForgetMarkerPayload) {
    const markers = yield* RunMarkersRepository;

    const held = (yield* markers.findMany(RunMarkerSpecifications.forRun(runId))).filter((marker) =>
      RunMarkerRootOps.same(marker, { runId, name, args, keepOn: [] }),
    );

    for (const marker of held) {
      yield* markers.deleteOne(marker);
    }
  },
  withUnitOfWork,
  // state.db is a file on this machine: it has no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
