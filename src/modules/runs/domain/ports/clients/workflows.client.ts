import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type RunId } from "../../../../../kernel/run-id.id.ts";
import { type RunEnding } from "../../run/run-status.value-object.ts";
import { type SpokeEnding } from "../../run/spoke-ending.value-object.ts";
import { type SpokeReport } from "../../run/spoke-report.value-object.ts";
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
  // The id of a run's execution, which is keyed by the run: what a hub
  // attaches to a run before its spoke executes it (ADR 23, decision 2).
  readonly executionIdOf: (flow: FlowRef, runId: RunId, item: WorkItem) => Effect.Effect<string>;
  // Starts a run's workflow, in a journal of its own; the id of its execution.
  readonly execute: (flow: FlowRef, runId: RunId, item: WorkItem) => Effect.Effect<string>;
  // How an execution ended; none while it runs, or for a flow this engine
  // doesn't run.
  readonly poll: (
    flow: FlowRef,
    executionId: string,
  ) => Effect.Effect<Option.Option<WorkflowOutcome>>;
  // Interrupts an execution that executes in this process, for good: the
  // engine keeps the interrupt in its journal. An agent call in progress stops at once, leaving its
  // session open; any other activity in progress finishes first. It reaches
  // nothing in a journal this process hasn't open: a spoke's workflow stops
  // when its spoke is ended (RunSpokesClient, ADR 23 decision 5), and a
  // journal nobody runs any more is deleted when its run ends.
  readonly interrupt: (flow: FlowRef, executionId: string) => Effect.Effect<void>;
  // Lets go of a run's journal once the run has ended: its execution is
  // interrupted and its engine closed, then its file is deleted. Nothing for
  // a run with none, so it is safe to repeat.
  readonly discard: (runId: RunId) => Effect.Effect<void>;
  // The runs with a journal on this machine.
  readonly journals: Effect.Effect<ReadonlyArray<RunId>>;
  // Whether the run's workflow executes in this process, rather than in a
  // spoke of its own (ADR 23): only then can this process wait for it to stop.
  readonly executing: (runId: RunId) => Effect.Effect<boolean>;
  // A spoke's last report, in its run's journal: how the run ended, for the
  // hub to end it with once the spoke has exited (ADR 23, decisions 2 and 3).
  readonly reportEnded: (runId: RunId, ending: SpokeEnding) => Effect.Effect<void>;
  // The last ending a run's spoke reported; none for a run with no journal,
  // or a spoke that exited before it said.
  readonly reportedEnding: (runId: RunId) => Effect.Effect<Option.Option<SpokeEnding>>;
  // The reports a run's spoke wrote in its journal after `after`, in order,
  // for the hub to fold into state.db (ADR 23, decisions 3 and 8); none for a
  // run with no journal.
  readonly reports: (runId: RunId, after: number) => Effect.Effect<ReadonlyArray<SpokeReport>>;
  // Adds a line to a run's log.
  readonly note: (runId: RunId, line: string) => Effect.Effect<void>;
};

export class WorkflowsClient extends Context.Service<WorkflowsClient, WorkflowsClientService>()(
  "WorkflowsClient",
) {}
