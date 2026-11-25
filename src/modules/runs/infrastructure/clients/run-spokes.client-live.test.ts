import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import {
  RunSpokesClient,
  type RunSpokesClientService,
} from "../../domain/ports/clients/run-spokes.client.ts";
import { RunSpokesClientLive } from "./run-spokes.client-live.ts";

const run = RunId.make("run-1");

const ended = (spokes: Option.Option<RunSpokesClientService>) =>
  RunSpokesClient.use((client) => client.end(run, "cancelled")).pipe(
    Effect.provide(RunSpokesClientLive(spokes)),
  );

describe("RunSpokesClientLive", () => {
  effect("a process with no spokes ends none", () =>
    Effect.gen(function* () {
      expect(yield* ended(Option.none())).toEqual(Option.none());
    }),
  );

  effect("a hub's spokes end the run's, for the ending it is about to take", () =>
    Effect.gen(function* () {
      const asked: Array<string> = [];

      const hub = RunSpokesClient.of({
        end: (runId, ending) =>
          Effect.sync(() => {
            asked.push(`${runId} ${ending}`);

            return Option.some({ exit: "killed by SIGTERM", sessions: [] });
          }),
      });

      expect(yield* ended(Option.some(hub))).toEqual(
        Option.some({ exit: "killed by SIGTERM", sessions: [] }),
      );
      expect(asked).toEqual(["run-1 cancelled"]);
    }),
  );
});
