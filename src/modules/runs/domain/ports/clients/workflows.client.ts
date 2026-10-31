import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type RunId } from "../../../../../kernel/run-id.id.ts";
import { type RunEnding } from "../../run/run-status.value-object.ts";
import { type FlowRef, type WorkItem } from "../../run/work-item.value-object.ts";

// How a workflow ended.
export type WorkflowOutcome = { readonly status: RunEnding; readonly summary: string };

// The durable workflow engine a run's flow executes in, journaled so a run in
// flight survives a restart.
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
  // Starts a run's workflow; the id of its execution.
  readonly execute: (flow: FlowRef, runId: RunId, item: WorkItem) => Effect.Effect<string>;
  // How an execution ended; none while it runs, or for a flow this engine
  // doesn't run.
  readonly poll: (
    flow: FlowRef,
    executionId: string,
  ) => Effect.Effect<Option.Option<WorkflowOutcome>>;
  // Resumes an execution that was suspended, as a restart leaves one.
  readonly resume: (flow: FlowRef, executionId: string) => Effect.Effect<void>;
  // Interrupts an execution for good: the engine keeps the interrupt, so it
  // holds across a restart, even for a flow this process didn't load. An
  // agent call in progress stops at once, leaving its session open; any
  // other activity in progress finishes first.
  readonly interrupt: (flow: FlowRef, executionId: string) => Effect.Effect<void>;
  // Completes a durable deferred a run waits on, waking it.
  readonly wake: (deferred: string, token: string) => Effect.Effect<void>;
  // Adds a line to a run's log.
  readonly note: (runId: RunId, line: string) => Effect.Effect<void>;
};

export class WorkflowsClient extends Context.Service<WorkflowsClient, WorkflowsClientService>()(
  "WorkflowsClient",
) {}
