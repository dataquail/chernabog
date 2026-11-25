import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import {
  FlowFailed,
  RunAlreadyActive,
  RunAlreadyFinished,
  RunNotFound,
} from "../domain/run/run.errors.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { type ExecuteRunPayload } from "./execute-run.command.ts";

// The unit of work around this command's reads and writes in state.db alone.
// What it asks of the engine stays outside it: a transaction holds state.db's
// one connection, which the runs' steps wait on
// (docs/adr/0010-commands-declare-their-unit-of-work.md).
const inUnitOfWork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    withUnitOfWork,
    // state.db is a file on this machine: it has no outage to wait out.
    Effect.catchTag("PersistenceUnavailable", Effect.die),
  );

export const executeRunHandler = Effect.fn("executeRunHandler")(function* ({
  item,
  runId,
}: ExecuteRunPayload) {
  const runs = yield* RunsRepository;
  const workflows = yield* WorkflowsClient;
  const found = yield* runs.findOne(RunSpecifications.withId(runId)).pipe(inUnitOfWork);

  if (Option.isNone(found)) {
    return yield* new RunNotFound({ runId });
  }

  const run = found.value;

  if (!RunRootOps.isRunning(run)) {
    return yield* new RunAlreadyFinished({ runId, status: run.status });
  }

  // Only a run a hub recorded is handed over: the hub attaches its
  // execution with it, in the one unit of work that takes the item
  // (StartSpokeRunCommand), so a run without one is no hub's to give.
  if (Option.isNone(run.executionId)) {
    return yield* new FlowFailed({
      message: `run ${runId} has no execution: a hub records one with the run before it hands it over`,
    });
  }

  // A run with a journal already has its spoke: a second would replay the
  // same run beside it. The hub records and attaches a run in one unit of
  // work and spawns one spoke for it (StartSpokeRunCommand), so this guards
  // only a hand-over made twice.
  if ((yield* workflows.journals).includes(runId)) {
    return yield* new RunAlreadyActive({ runId });
  }

  const flow = { repo: run.repo, flow: run.flow, persona: run.persona };

  if (!workflows.runs(flow)) {
    return yield* new FlowFailed({
      message: `this process didn't load ${run.repo}'s ${run.flow}, which run ${runId} is of`,
    });
  }

  // Its execution is keyed by the run, which the hub attached when it
  // recorded the run: executing it writes nothing to state.db.
  yield* workflows.execute(flow, runId, item);

  return RunView.make({ ...run });
});
