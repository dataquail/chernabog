import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";

import { RunSpokeSpecifications } from "../domain/run-spoke/run-spoke.specification.ts";
import { RunSpokesRepository } from "../domain/run-spoke/run-spokes.repository.ts";
import { type ForgetSpokePayload } from "./forget-spoke.command.ts";

export const forgetSpokeHandler = Effect.fn("forgetSpokeHandler")(
  function* ({ runId }: ForgetSpokePayload) {
    const spokes = yield* RunSpokesRepository;

    for (const spoke of yield* spokes.findMany(RunSpokeSpecifications.forRun(runId))) {
      yield* spokes.deleteOne(spoke);
    }
  },
  withUnitOfWork,
  // state.db is a file on this machine: it has no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
