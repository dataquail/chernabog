import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import {
  RunSpokesClient,
  type RunSpokesClientService,
} from "../../domain/ports/clients/run-spokes.client.ts";
import { endingOf } from "../../domain/run-spoke/spoke-end-request.value-object.ts";
import { RunSpokesClientLive } from "./run-spokes.client-live.ts";

const run = RunId.make("run-1");

// The run's spoke ended for a cancel, then forgotten, as its run ended.
const endedThenForgotten = (spokes: Option.Option<RunSpokesClientService>) =>
  RunSpokesClient.use((client) =>
    client
      .end(run, { by: "alice", closeSessions: false, endAs: Option.none() })
      .pipe(Effect.tap(() => client.forget(run))),
  ).pipe(Effect.provide(RunSpokesClientLive(spokes)));

describe("RunSpokesClientLive", () => {
  effect("a process with no spokes ends none, and has none to forget", () =>
    Effect.gen(function* () {
      expect(yield* endedThenForgotten(Option.none())).toEqual(Option.none());
    }),
  );

  effect("a hub's spokes end the run's, for the ending it is about to take, and forget it", () =>
    Effect.gen(function* () {
      const asked: Array<string> = [];

      const hub = RunSpokesClient.of({
        end: (runId, request) =>
          Effect.sync(() => {
            asked.push(`${runId} ${endingOf(request)} by ${request.by}`);

            return Option.some({
              endedFor: endingOf(request),
              exit: "killed by SIGTERM",
              sessions: [],
            });
          }),
        forget: (runId) =>
          Effect.sync(() => {
            asked.push(`forget ${runId}`);
          }),
      });

      expect(yield* endedThenForgotten(Option.some(hub))).toEqual(
        Option.some({ endedFor: "cancelled", exit: "killed by SIGTERM", sessions: [] }),
      );
      expect(asked).toEqual(["run-1 cancelled by alice", "forget run-1"]);
    }),
  );
});
