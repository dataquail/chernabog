import { EventBus } from "@effect-server-utils/cqrs";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { RunEvents } from "../domain/run/run.events.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { type StartRunPayload } from "./start-run.command.ts";

export const startRunHandler = Effect.fn("startRunHandler")(function* (run: StartRunPayload) {
  const runs = yield* RunsRepository;

  const started = yield* Effect.fromResult(
    RunRootOps.start(
      yield* runs.findMany(RunSpecifications.running),
      run,
      DateTime.formatIso(yield* DateTime.now),
    ),
  );

  yield* runs.upsertOne(started);
  yield* (yield* EventBus).dispatch([RunEvents.started(started)]);

  return RunView.make({ ...started });
});
