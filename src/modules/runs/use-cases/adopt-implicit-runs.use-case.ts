import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { AdoptedRuns } from "./run.result.ts";

// Once a repo has named personas, its runs from before them become the
// persona's it runs as first, so they keep resuming and holding its slots.
export const adoptImplicitRunsUseCase = Effect.fn("adoptImplicitRunsUseCase")(function* (
  repo: string,
  login: string,
) {
  const runs = yield* RunsRepository;

  const adopted = (yield* runs.findAll({ repo })).flatMap((run) =>
    Option.toArray(RunRootOps.adopt(run, login)),
  );

  yield* Effect.forEach(adopted, runs.save, { discard: true });

  return AdoptedRuns.make({ runs: adopted.map((run) => run.id) });
});
