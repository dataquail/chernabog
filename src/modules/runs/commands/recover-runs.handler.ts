import { EventBus } from "@effect-server-utils/cqrs";
import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Result from "effect/Result";

import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import { type RunAlreadyFinished } from "../domain/run/run.errors.ts";
import { RunEvents } from "../domain/run/run.events.ts";
import { type RunRoot } from "../domain/run/run.root.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { RecoveredRuns, RunView } from "../domain/run/run-view.value-object.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";

// The unit of work around this command's reads and writes in state.db alone.
// What it asks of GitHub, git, a launcher or the engine stays outside it: a
// transaction holds state.db's one connection, which the runs' steps
// wait on (docs/adr/0010-commands-declare-their-unit-of-work.md).
const inUnitOfWork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    withUnitOfWork,
    // state.db is a file on this machine: it has no outage to wait out.
    Effect.catchTag("PersistenceUnavailable", Effect.die),
  );

const INTERRUPTED = "interrupted before its workflow started";

const JOURNAL_GONE =
  "its journal was gone after a restart, and it kept no work item to start it from";

export const recoverRunsHandler = Effect.fn("recoverRunsHandler")(function* () {
  const runs = yield* RunsRepository;
  const workflows = yield* WorkflowsClient;
  const events = yield* EventBus;

  const running = yield* runs.findMany(RunSpecifications.running);
  const interrupted = running.flatMap((run) => Option.toArray(RunRootOps.unexecuted(run)));

  const executed: Array<RunView> = [];
  const abandoned: Array<RunView> = [];
  const left: Array<RunView> = [];

  // The ops can't fail here: every run recovered is still running.
  const saved = (change: Result.Result<RunRoot, RunAlreadyFinished>) =>
    Effect.fromResult(change).pipe(Effect.orDie, Effect.tap(runs.upsertOne));

  for (const run of interrupted) {
    if (Option.isNone(run.item)) {
      const at = DateTime.formatIso(yield* DateTime.now);

      const ended = yield* saved(RunRootOps.finish(run, "failed", INTERRUPTED, at)).pipe(
        Effect.tap((one) => events.dispatch(Option.toArray(RunEvents.finished(one)))),
        inUnitOfWork,
      );

      abandoned.push(RunView.make({ ...ended }));
      continue;
    }

    const flow = { repo: run.repo, flow: run.flow, persona: run.persona };

    if (!workflows.runs(flow)) {
      left.push(RunView.make({ ...run }));
      continue;
    }

    const executionId = yield* workflows.execute(flow, run.id, run.item.value);

    const attached = yield* saved(RunRootOps.attachExecution(run, executionId)).pipe(inUnitOfWork);

    executed.push(RunView.make({ ...attached }));
  }

  // A journal whose run has ended is a reaction a crash lost: deleted now.
  const swept: Array<string> = [];
  const live = new Set(running.map((run) => String(run.id)));

  for (const runId of yield* workflows.journals) {
    if (!live.has(runId)) {
      yield* workflows.discard(runId);
      swept.push(runId);
    }
  }

  // Transitional, until reaping ends a restart's runs (#664) and the
  // in-process path goes (#665): delete from here to the return then.
  const resumed: Array<RunView> = [];
  const repeated: Array<RunView> = [];

  for (const run of running) {
    const flow = { repo: run.repo, flow: run.flow, persona: run.persona };

    for (const executionId of Option.toArray(run.executionId)) {
      if (!workflows.runs(flow)) {
        continue;
      }

      if (yield* workflows.resume(flow, run.id, executionId)) {
        resumed.push(RunView.make({ ...run }));
        continue;
      }

      // Its journal is gone: its phase starts again, in a journal of its own.
      // The execution is keyed by the run, so it keeps its id.
      if (Option.isSome(run.item)) {
        yield* workflows.execute(flow, run.id, run.item.value);
        repeated.push(RunView.make({ ...run }));
        continue;
      }

      const at = DateTime.formatIso(yield* DateTime.now);

      const ended = yield* saved(RunRootOps.finish(run, "failed", JOURNAL_GONE, at)).pipe(
        Effect.tap((one) => events.dispatch(Option.toArray(RunEvents.finished(one)))),
        inUnitOfWork,
      );

      abandoned.push(RunView.make({ ...ended }));
    }
  }

  return RecoveredRuns.make({ executed, abandoned, left, resumed, repeated, swept });
});
