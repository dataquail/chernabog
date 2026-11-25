import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import { FlowFailed, RunAlreadyActive, RunAlreadyFinished } from "../domain/run/run.errors.ts";
import { type ExecuteRunPayload } from "./execute-run.command.ts";

export const executeRunHandler = Effect.fn("executeRunHandler")(
  function* ({ item, run }: ExecuteRunPayload) {
    const workflows = yield* WorkflowsClient;
    const runId = run.id;

    if (run.status !== "running") {
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

    return run;
  },
  // It touches no store: its unit of work opens nothing
  // (docs/adr/0010-commands-declare-their-unit-of-work.md).
  withUnitOfWork,
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
