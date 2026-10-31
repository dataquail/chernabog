import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { AdoptedRuns } from "../domain/run/run-view.value-object.ts";
import { type AdoptImplicitRunsPayload } from "./adopt-implicit-runs.command.ts";

export const adoptImplicitRunsHandler = Effect.fn("adoptImplicitRunsHandler")(
  function* ({ login, repo }: AdoptImplicitRunsPayload) {
    const runs = yield* RunsRepository;

    const adopted = (yield* runs.findAll({ repo })).flatMap((run) =>
      Option.toArray(RunRootOps.adopt(run, login)),
    );

    yield* Effect.forEach(adopted, runs.save, { discard: true });

    return AdoptedRuns.make({ runs: adopted.map((run) => run.id) });
  },
  withUnitOfWork,
  // state.db is a file on this machine: it has no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
