import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type RunId } from "../../../../../kernel/run-id.id.ts";
import { type RunEnding } from "../../run/run-status.value-object.ts";
import { type FlowRef, type WorkItem } from "../../run/work-item.value-object.ts";

// How a workflow ended.
export type WorkflowOutcome = { readonly status: RunEnding; readonly summary: string };

// The durable workflow engine a run's flow executes in, journaled in a file of
// the run's own (ADR 23, decision 3), created when the run executes and
// deleted when it ends.
export type WorkflowsClientService = {
  // The @chernabog/core version workflows here run under, which a run started
  // now records.
  readonly coreVersion: string;
  // The .chernabog/ tree this engine loaded the flow from, which a run started
  // now records and resumes against; none for one from a working copy.
  readonly treeOf: (flow: FlowRef) => Option.Option<string>;
  // Whether this engine runs the flow's workflow; a process runs only the
  // flows it loaded.
  readonly runs: (flow: FlowRef) => boolean;
  // Starts a run's workflow, in a journal of its own; the id of its execution.
  readonly execute: (flow: FlowRef, runId: RunId, item: WorkItem) => Effect.Effect<string>;
  // How an execution ended; none while it runs, or for a flow this engine
  // doesn't run.
  readonly poll: (
    flow: FlowRef,
    executionId: string,
  ) => Effect.Effect<Option.Option<WorkflowOutcome>>;
  // Resumes a run's execution from its journal, opening the journal if this
  // process hasn't, as after a restart; whether the run had a journal here.
  readonly resume: (flow: FlowRef, runId: RunId, executionId: string) => Effect.Effect<boolean>;
  // Interrupts an execution for good: the engine keeps the interrupt, so it
  // holds across a restart, even for a flow this process didn't load. An
  // agent call in progress stops at once, leaving its session open; any
  // other activity in progress finishes first.
  readonly interrupt: (flow: FlowRef, executionId: string) => Effect.Effect<void>;
  // Lets go of a run's journal once the run has ended: its execution is
  // interrupted and its engine closed, then its file is deleted. Nothing for
  // a run with none, so it is safe to repeat.
  readonly discard: (runId: RunId) => Effect.Effect<void>;
  // The runs with a journal on this machine.
  readonly journals: Effect.Effect<ReadonlyArray<RunId>>;
  // Completes a durable deferred a run waits on, waking it.
  readonly wake: (deferred: string, token: string) => Effect.Effect<void>;
  // Adds a line to a run's log.
  readonly note: (runId: RunId, line: string) => Effect.Effect<void>;
};

export class WorkflowsClient extends Context.Service<WorkflowsClient, WorkflowsClientService>()(
  "WorkflowsClient",
) {}
