import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunNotFound } from "../domain/run/run.errors.ts";
import { type RunEnding } from "../domain/run/run.root.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunView } from "./run.result.ts";

// How a run ended, from its workflow's outcome.
export type RunOutcome = { readonly status: RunEnding; readonly summary: string };

// Records a run as ended, once its workflow completes. A run ends once: a
// second ending fails, leaving the first.
export const finishRunUseCase = Effect.fn("finishRunUseCase")(function* (
  runId: RunId,
  outcome: RunOutcome,
) {
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

  return RunView.make({ ...finished });
});
