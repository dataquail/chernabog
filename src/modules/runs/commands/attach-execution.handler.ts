import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunNotFound } from "../domain/run/run.errors.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";
import { type AttachExecutionPayload } from "./attach-execution.command.ts";

export const attachExecutionHandler = Effect.fn("attachExecutionHandler")(function* ({
  executionId,
  runId,
}: AttachExecutionPayload) {
  const runs = yield* RunsRepository;
  const found = yield* runs.findOne(runId);

  if (Option.isNone(found)) {
    return yield* new RunNotFound({ runId });
  }

  const changed = yield* Effect.fromResult(RunRootOps.attachExecution(found.value, executionId));
  yield* runs.save(changed);

  return RunView.make({ ...changed });
});
