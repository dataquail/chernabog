import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";

import { RunWaitsRepository } from "../domain/ports/repositories/run-waits.repository.ts";
import { RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
import { type ReleaseRunWaitPayload } from "./release-run-wait.command.ts";

export const releaseRunWaitHandler = Effect.fn("releaseRunWaitHandler")(
  function* ({ wait }: ReleaseRunWaitPayload) {
    yield* (yield* RunWaitsRepository).remove(RunWaitRoot.make({ ...wait }));

    return wait;
  },
  withUnitOfWork,
  // state.db is a file on this machine: it has no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
