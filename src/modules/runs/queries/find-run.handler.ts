import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunSpecifications } from "../domain/run/run.specification.ts";
import { FoundRun, RunView } from "../domain/run/run-view.value-object.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { type FindRunPayload } from "./find-run.query.ts";

export const findRunHandler = Effect.fn("findRunHandler")(function* ({ runId }: FindRunPayload) {
  const run = yield* (yield* RunsRepository).findOne(RunSpecifications.withId(runId));

  return FoundRun.make({ run: Option.map(run, (found) => RunView.make({ ...found })) });
});
