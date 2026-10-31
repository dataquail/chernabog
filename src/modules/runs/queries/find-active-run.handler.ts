import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { FoundRun, RunView } from "../domain/run/run-view.value-object.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { type FindActiveRunPayload } from "./find-active-run.query.ts";

export const findActiveRunHandler = Effect.fn("findActiveRunHandler")(function* (
  wanted: FindActiveRunPayload,
) {
  const running = yield* (yield* RunsRepository).findMany(RunSpecifications.running);

  return FoundRun.make({
    run: Option.map(RunRootOps.activeFor(running, wanted), (run) => RunView.make({ ...run })),
  });
});
