import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { FoundRun, RunView } from "../domain/run/run-view.value-object.ts";
import { type FindRunPayload } from "./find-run.query.ts";

export const findRunHandler = Effect.fn("findRunHandler")(function* ({ runId }: FindRunPayload) {
  const run = yield* (yield* RunsRepository).findOne(runId);

  return FoundRun.make({ run: Option.map(run, (found) => RunView.make({ ...found })) });
});
