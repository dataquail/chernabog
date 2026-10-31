// What the runs' spans say about the run a message or event is about: its
// id, and the repo and flow it runs, wherever the message carries them. The
// dispatchers in runs.command-handlers.ts and runs.query-handlers.ts, and the
// runs' event bus, are built with these, so a command, query or event's span
// can be found by the run it was for
// (docs/adr/0009-the-hexagons-remaining-stereotypes.md).

import { Event } from "@effect-server-utils/cqrs";

import { type RunId } from "../../kernel/run-id.id.ts";
import { type RunMarkersReleased } from "./domain/run-marker/run-marker.events.ts";
import {
  type PullRequestOpened,
  type RunEnteredStep,
  type RunFinished,
  type RunNeedsAttention,
  type RunStarted,
} from "./domain/run/run.events.ts";

// A message or event about one run.
const ofRun = (message: { readonly runId: RunId }) => ({ "run.id": message.runId });

// A message about one of a repo's flows.
const ofFlow = (message: { readonly repo: string; readonly flow: string }) => ({
  "run.repo": message.repo,
  "run.flow": message.flow,
});

// A message about a flow as one persona runs it.
const ofFlowRef = (message: { readonly flow: { readonly repo: string; readonly flow: string } }) =>
  ofFlow(message.flow);

export const runsCommandSpanAttributes = {
  AdoptImplicitRunsCommand: (payload: { readonly repo: string }) => ({ "run.repo": payload.repo }),
  AttachExecutionCommand: ofRun,
  EnterStepCommand: ofRun,
  FinishRunCommand: ofRun,
  ForgetMarkerCommand: ofRun,
  HoldMarkerCommand: ofRun,
  NameSubjectCommand: ofRun,
  ParkRunCommand: ofRun,
  RecordSkipCommand: ofFlow,
  ReleaseRunWaitCommand: (payload: { readonly wait: { readonly runId: RunId } }) =>
    ofRun(payload.wait),
  StartRunCommand: (payload: {
    readonly id: RunId;
    readonly repo: string;
    readonly flow: string;
  }) => ({ "run.id": payload.id, ...ofFlow(payload) }),
} as const;

export const runFlowsCommandSpanAttributes = {
  CheckRunLeasesCommand: ofRun,
  DeliverSignalsCommand: ofFlowRef,
  GateFlowCommand: ofFlowRef,
  PlanTickCommand: ofFlowRef,
  PollRunCommand: ofRun,
  ResumeRunCommand: ofRun,
  StartFlowRunCommand: ofFlowRef,
} as const;

export const runsQuerySpanAttributes = {
  FindActiveRunQuery: ofFlow,
  FindRunQuery: ofRun,
  ListRunMarkersQuery: ofRun,
  ListRunWaitsQuery: ofRun,
  ReadRunHistoryQuery: ofRun,
} as const;

export const runFlowsQuerySpanAttributes = { CheckRunValidityQuery: ofRun } as const;

export const runLogsQuerySpanAttributes = {
  FollowRunLogQuery: ofRun,
  ReadRunLogQuery: ofRun,
} as const;

export const runEventSpanAttributes = Event.spanAttributes({
  RunStarted: (event: RunStarted) => ({ "run.id": event.runId, ...ofFlow(event) }),
  RunEnteredStep: (event: RunEnteredStep) => ofRun(event),
  RunNeedsAttention: (event: RunNeedsAttention) => ofRun(event),
  RunFinished: (event: RunFinished) => ofRun(event),
  RunMarkersReleased: (event: RunMarkersReleased) => ofRun(event),
  PullRequestOpened: (event: PullRequestOpened) => ({
    "run.id": event.runId,
    "run.repo": event.repo,
  }),
});
