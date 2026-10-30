import { EventBus } from "@effect-server-utils/cqrs";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunNotFound } from "../domain/run/run.errors.ts";
import { RunEvents } from "../domain/run/run.events.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";
import { type FinishRunPayload } from "./finish-run.command.ts";

export const finishRunHandler = Effect.fn("finishRunHandler")(function* ({
  runId,
  ...outcome
}: FinishRunPayload) {
  const runs = yield* RunsRepository;
  const found = yield* runs.findOne(runId);

  if (Option.isNone(found)) {
    return yield* new RunNotFound({ runId });
  }

  const finished = yield* Effect.fromResult(
    RunRootOps.finish(
      found.value,
      outcome.status,
      outcome.summary,
      DateTime.formatIso(yield* DateTime.now),
    ),
  );

  yield* runs.save(finished);
  yield* (yield* EventBus).dispatch(Option.toArray(RunEvents.finished(finished)));

  return RunView.make({ ...finished });
});
