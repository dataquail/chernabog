import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Record from "effect/Record";

import { type RunId } from "../../../../kernel/run-id.id.ts";
import {
  type WorkflowOutcome,
  WorkflowsClient,
} from "../../domain/ports/clients/workflows.client.ts";

// What a test's workflow engine did and was told: the runs it executed, the
// executions it resumed and interrupted, the deferreds it woke and the lines it noted, and
// the outcome each execution ends with, and the flows (as repo/flow) it has
// no workflow for, which a test sets.
export type FakeEngine = {
  readonly executed: Array<RunId>;
  readonly resumed: Array<string>;
  readonly interrupted: Array<string>;
  readonly woken: Array<string>;
  readonly notes: Array<string>;
  readonly outcomes: Record<string, WorkflowOutcome>;
  readonly unloaded: Array<string>;
};

export const fakeEngine = (): FakeEngine => ({
  executed: [],
  resumed: [],
  interrupted: [],
  woken: [],
  notes: [],
  outcomes: {},
  unloaded: [],
});

// Executions named `execution-<runId>`.
export const WorkflowsClientFake = (engine: FakeEngine) =>
  Layer.succeed(
    WorkflowsClient,
    WorkflowsClient.of({
      runs: (flow) => !engine.unloaded.includes(`${flow.repo}/${flow.flow}`),
      execute: (_flow, runId) =>
        Effect.sync(() => {
          engine.executed.push(runId);

          return `execution-${runId}`;
        }),
      poll: (_flow, executionId) => Effect.sync(() => Record.get(engine.outcomes, executionId)),
      resume: (_flow, executionId) =>
        Effect.sync(() => {
          engine.resumed.push(executionId);
        }),
      interrupt: (_flow, executionId) =>
        Effect.sync(() => {
          engine.interrupted.push(executionId);
        }),
      wake: (deferred) =>
        Effect.sync(() => {
          engine.woken.push(deferred);
        }),
      note: (runId, line) =>
        Effect.sync(() => {
          engine.notes.push(`${runId}: ${line}`);
        }),
    }),
  );
