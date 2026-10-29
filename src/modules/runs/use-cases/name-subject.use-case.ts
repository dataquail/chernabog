import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunNotFound } from "../domain/run/run.errors.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunView } from "./run.result.ts";

// A run naming a work item it touched, such as the pull request an issue's
// run opened: what makes the runs that share a subject one piece of work.
export const nameSubjectUseCase = Effect.fn("nameSubjectUseCase")(function* (
  runId: RunId,
  subject: string,
) {
  const runs = yield* RunsRepository;
  const found = yield* runs.findOne(runId);

  if (Option.isNone(found)) {
    return yield* new RunNotFound({ runId });
  }

  const changed = yield* Effect.fromResult(RunRootOps.nameSubject(found.value, subject));
  yield* runs.save(changed);

  return RunView.make({ ...changed });
});
