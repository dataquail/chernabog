import { EventBus } from "@effect-server-utils/cqrs";
import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { RunId } from "../../../kernel/run-id.id.ts";
import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import { RunEvents } from "../domain/run/run.events.ts";
import { type RunRoot } from "../domain/run/run.root.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { RunView, StartedRun } from "../domain/run/run-view.value-object.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { mayStart } from "../domain/run/work-item.value-object.ts";
import { type StartFlowRunPayload } from "./start-flow-run.command.ts";

// The unit of work around this command's reads and writes in state.db alone.
// What it asks of GitHub, git, a launcher or the engine stays outside it: a
// transaction holds state.db's one connection, which the engine's journal
// waits on (docs/adr/0010-commands-declare-their-unit-of-work.md).
const inUnitOfWork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    withUnitOfWork,
    // state.db is a file on this machine: it has no outage to wait out.
    Effect.catchTag("PersistenceUnavailable", Effect.die),
  );

// A run's id says nothing about it: its record says what it runs, and as whom.
// Random rather than time-ordered, so a few characters of it name a run.
const newRunId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()).pipe(
  Effect.map(RunId.make),
  Effect.orDie,
);

export const startFlowRunHandler = Effect.fn("startFlowRunHandler")(function* ({
  flow,
  item,
}: StartFlowRunPayload) {
  const runs = yield* RunsRepository;
  const workflows = yield* WorkflowsClient;
  const wanted = { repo: flow.repo, persona: flow.persona, flow: flow.flow, itemKey: item.key };
  const running = yield* runs.findMany(RunSpecifications.running);

  // The run already in flight, as it's stored now.
  const existing = (found: Option.Option<{ readonly id: RunId }>) =>
    Option.match(found, {
      onNone: () => Effect.succeed(Option.none<RunRoot>()),
      onSome: (one) => runs.findOne(RunSpecifications.withId(one.id)),
    }).pipe(
      Effect.map((run) =>
        StartedRun.make({
          run: Option.map(run, (one) => RunView.make({ ...one })),
          started: false,
        }),
      ),
    );

  if (!mayStart(item)) {
    return yield* existing(RunRootOps.activeFor(running, wanted));
  }

  const started = RunRootOps.start(
    running,
    {
      ...wanted,
      id: yield* newRunId,
      coreVersion: workflows.coreVersion,
      configTree: workflows.treeOf(flow),
      itemTitle: Option.fromUndefinedOr(item.title),
      itemUrl: Option.fromUndefinedOr(item.url),
      item: Option.some(item),
    },
    DateTime.formatIso(yield* DateTime.now),
  );

  if (Result.isFailure(started)) {
    return yield* existing(Option.some({ id: started.failure.runId }));
  }

  // Recorded before its workflow executes, so a crash between leaves a run
  // RecoverRunsCommand executes.
  yield* Effect.gen(function* () {
    yield* runs.upsertOne(started.success);
    yield* (yield* EventBus).dispatch([RunEvents.started(started.success)]);
  }).pipe(inUnitOfWork);

  const executionId = yield* workflows.execute(flow, started.success.id, item);

  // The run can't have ended yet: nothing polls it before it has an execution.
  const attached = yield* Effect.fromResult(
    RunRootOps.attachExecution(started.success, executionId),
  ).pipe(Effect.orDie);

  yield* runs.upsertOne(attached).pipe(inUnitOfWork);

  return StartedRun.make({ run: Option.some(RunView.make({ ...attached })), started: true });
});
