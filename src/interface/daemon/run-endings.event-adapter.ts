// How the daemon learns that a run ended: from RunFinished on the bus, however
// it ended (polled, cancelled, superseded, lost, or abandoned by recovery),
// rather than from one command's result. An inbound adapter over the bus, as
// the socket is one over HTTP (docs/adr/0013-event-handlers.md).

import { EventBus } from "@effect-server-utils/cqrs";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunFinished, RunsQueries, type RunView } from "../../modules/runs/runs.platform.ts";

// Subscribes `react` to every run that ends, after its ending commits, with
// the run as it then reads. A repeat of an ending (the same eventId) reaches
// it once; its failure is reported and undoes nothing.
export const subscribeRunEndings = (react: (ended: RunView) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const bus = yield* EventBus;
    const runs = yield* RunsQueries;

    yield* bus.subscribeAfterCommit(
      RunFinished,
      (event) =>
        runs
          .FindRunQuery({ runId: event.runId })
          .pipe(
            Effect.flatMap((found) =>
              Effect.forEach(Option.toArray(found.run), react, { discard: true }),
            ),
          ),
      { name: "daemon/run-endings" },
    );
  });
