// The spokes a process's runs execute in, as its root says: a hub hands the
// runs module its own (ADR 23); any other process runs no spoke, so ending a
// run's spoke finds none.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  RunSpokesClient,
  type RunSpokesClientService,
} from "../../domain/ports/clients/run-spokes.client.ts";

export const RunSpokesClientLive = (spokes: Option.Option<RunSpokesClientService>) =>
  Layer.succeed(
    RunSpokesClient,
    RunSpokesClient.of({
      end: (runId, request) =>
        Option.match(spokes, {
          onNone: () => Effect.succeedNone,
          onSome: (hub) => hub.end(runId, request),
        }),
      forget: (runId) =>
        Option.match(spokes, {
          onNone: () => Effect.void,
          onSome: (hub) => hub.forget(runId),
        }),
    }),
  );
