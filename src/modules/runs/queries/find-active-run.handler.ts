import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { FoundRun, RunView } from "../domain/run/run-view.value-object.ts";
import { type FindActiveRunPayload } from "./find-active-run.query.ts";

export const findActiveRunHandler = Effect.fn("findActiveRunHandler")(function* (
  wanted: FindActiveRunPayload,
) {
  const running = yield* (yield* RunsRepository).findAll({ running: true });

  return FoundRun.make({
    run: Option.map(RunRootOps.activeFor(running, wanted), (run) => RunView.make({ ...run })),
  });
});
