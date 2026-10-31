import { EventBus } from "@effect-server-utils/cqrs";
import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunEvents } from "../domain/run/run.events.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";
import { type StartRunPayload } from "./start-run.command.ts";

export const startRunHandler = Effect.fn("startRunHandler")(
  function* (run: StartRunPayload) {
    const runs = yield* RunsRepository;

    const started = yield* Effect.fromResult(
      RunRootOps.start(
        yield* runs.findAll({ running: true }),
        run,
        DateTime.formatIso(yield* DateTime.now),
      ),
    );

    yield* runs.save(started);
    yield* (yield* EventBus).dispatch([RunEvents.started(started)]);

    return RunView.make({ ...started });
  },
  withUnitOfWork,
  // state.db is a file on this machine: it has no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
