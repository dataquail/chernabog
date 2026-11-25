import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunSpokeRoot } from "../domain/run-spoke/run-spoke.root.ts";
import { RunSpokesRepository } from "../domain/run-spoke/run-spokes.repository.ts";
import { type RecordSpokePayload } from "./record-spoke.command.ts";

export const recordSpokeHandler = Effect.fn("recordSpokeHandler")(
  function* (spoke: RecordSpokePayload) {
    yield* (yield* RunSpokesRepository).upsertOne(
      RunSpokeRoot.make({ ...spoke, foldedSeq: 0, ending: Option.none() }),
    );
  },
  withUnitOfWork,
  // state.db is a file on this machine: it has no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
