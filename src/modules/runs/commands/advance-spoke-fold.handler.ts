import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";

import { RunSpokeRootOps } from "../domain/run-spoke/run-spoke.root-ops.ts";
import { RunSpokeSpecifications } from "../domain/run-spoke/run-spoke.specification.ts";
import { RunSpokesRepository } from "../domain/run-spoke/run-spokes.repository.ts";
import { type AdvanceSpokeFoldPayload } from "./advance-spoke-fold.command.ts";

export const advanceSpokeFoldHandler = Effect.fn("advanceSpokeFoldHandler")(
  function* ({ runId, seq }: AdvanceSpokeFoldPayload) {
    const spokes = yield* RunSpokesRepository;

    for (const spoke of yield* spokes.findMany(RunSpokeSpecifications.forRun(runId))) {
      yield* spokes.upsertOne(RunSpokeRootOps.advance(spoke, seq));
    }
  },
  withUnitOfWork,
  // state.db is a file on this machine: it has no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
