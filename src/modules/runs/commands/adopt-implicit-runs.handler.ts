import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { AdoptedRuns } from "../domain/run/run-view.value-object.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { type AdoptImplicitRunsPayload } from "./adopt-implicit-runs.command.ts";

export const adoptImplicitRunsHandler = Effect.fn("adoptImplicitRunsHandler")(function* ({
  login,
  repo,
}: AdoptImplicitRunsPayload) {
  const runs = yield* RunsRepository;

  const adopted = (yield* runs.findMany(RunSpecifications.forRepo(repo))).flatMap((run) =>
    Option.toArray(RunRootOps.adopt(run, login)),
  );

  yield* Effect.forEach(adopted, runs.upsertOne, { discard: true });

  return AdoptedRuns.make({ runs: adopted.map((run) => run.id) });
});
