import { Event } from "@effect-server-utils/cqrs";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { NodeRef, NodeRefs } from "../plan/node-ref.value-object.ts";
import { RunStatus } from "./run-status.value-object.ts";
import { StepOutcome } from "./step-outcome.value-object.ts";
import { itemTarget } from "./work-item.value-object.ts";

// What happens to a run, as its commands tell whoever listens: the
// dashboard's /events stream, the notifier. A resumed workflow re-executes
// code, so a command dispatches one only after the write that makes it true,
// and each carries an id from its run and the step it is about: a repeat has
// the same id, for a consumer to drop. Each is declared for the bus
// (Event.make), whose subscriptions route on its tag and seal it by its schema.

// The id of an event about `step` of a run, such as "started" or "step:ci".
export const runEventId = (runId: RunId, step: string) => `${runId}:${step}`;

// A run recorded as starting, before its workflow does.
export const RunStarted = Event.make("RunStarted", {
  eventId: Schema.String,
  runId: RunId,
  repo: Schema.String,
  persona: Schema.Option(Schema.String),
  flow: Schema.String,
  itemKey: Schema.String,
  startedAt: Schema.String,
});

export type RunStarted = typeof RunStarted.Type;

// A run entering a step, the first time it does: a resumed run that enters a
// step again tells no one. `node` is where in its plan the step ran; absent
// for a flow with no plan, and in an event from before steps carried one.
export const RunEnteredStep = Event.make("RunEnteredStep", {
  eventId: Schema.String,
  runId: RunId,
  step: Schema.String,
  node: Schema.optionalKey(NodeRef),
  enteredAt: Schema.String,
});

export type RunEnteredStep = typeof RunEnteredStep.Type;

// A step a run entered ending, once, with how: never for one interrupted, nor
// for one a resumed run reads back from its journal.
export const RunFinishedStep = Event.make("RunFinishedStep", {
  eventId: Schema.String,
  runId: RunId,
  step: Schema.String,
  node: Schema.optionalKey(NodeRef),
  outcome: StepOutcome,
  finishedAt: Schema.String,
});

export type RunFinishedStep = typeof RunFinishedStep.Type;

// A run entering a node of its plan, in a round and a lane, the first time
// it does, whether or not the node runs a step: a block that runs none is
// entered and left all the same. A resumed run that passes it again tells no one.
export const RunEnteredNode = Event.make("RunEnteredNode", {
  eventId: Schema.String,
  runId: RunId,
  node: NodeRef,
  enteredAt: Schema.String,
});

export type RunEnteredNode = typeof RunEnteredNode.Type;

// A run leaving a node of its plan it entered, once, with how: never for one
// interrupted.
export const RunFinishedNode = Event.make("RunFinishedNode", {
  eventId: Schema.String,
  runId: RunId,
  node: NodeRef,
  outcome: StepOutcome,
  finishedAt: Schema.String,
});

export type RunFinishedNode = typeof RunFinishedNode.Type;

// A run taking the branch of a node's block for `outcome`, once: a resumed
// run that takes it again tells no one.
export const RunTookBranch = Event.make("RunTookBranch", {
  eventId: Schema.String,
  runId: RunId,
  node: NodeRef,
  outcome: Schema.String,
  takenAt: Schema.String,
});

export type RunTookBranch = typeof RunTookBranch.Type;

// A run, or a lane of it, reaching the `end` at a node of its plan, once.
export const RunReachedEnd = Event.make("RunReachedEnd", {
  eventId: Schema.String,
  runId: RunId,
  node: NodeRef,
  reachedAt: Schema.String,
});

export type RunReachedEnd = typeof RunReachedEnd.Type;

// A run parked on a signal, such as a push to a review's pull request: it
// waits on someone, and holds no slot until it wakes.
export const RunNeedsAttention = Event.make("RunNeedsAttention", {
  eventId: Schema.String,
  runId: RunId,
  signal: Schema.String,
  deferred: Schema.String,
  parkedAt: Schema.String,
});

export type RunNeedsAttention = typeof RunNeedsAttention.Type;

// A run ending, once, however it ended.
export const RunFinished = Event.make("RunFinished", {
  eventId: Schema.String,
  runId: RunId,
  status: RunStatus,
  summary: Schema.String,
  finishedAt: Schema.String,
});

export type RunFinished = typeof RunFinished.Type;

// A run naming a pull request it opened as its subject, the first time it does.
export const PullRequestOpened = Event.make("PullRequestOpened", {
  eventId: Schema.String,
  runId: RunId,
  repo: Schema.String,
  number: Schema.Finite,
});

export type PullRequestOpened = typeof PullRequestOpened.Type;

const started = (run: {
  readonly id: RunId;
  readonly repo: string;
  readonly persona: Option.Option<string>;
  readonly flow: string;
  readonly itemKey: string;
  readonly startedAt: string;
}) =>
  RunStarted.make({
    eventId: runEventId(run.id, "started"),
    runId: run.id,
    repo: run.repo,
    persona: run.persona,
    flow: run.flow,
    itemKey: run.itemKey,
    startedAt: run.startedAt,
  });

// A step's node, as its event carries it: absent when it has none.
const nodeField = (node: Option.Option<NodeRef>) =>
  Option.match(node, { onNone: () => ({}), onSome: (found) => ({ node: found }) });

const enteredStep = (
  runId: RunId,
  step: string,
  enteredAt: string,
  node: Option.Option<NodeRef> = Option.none(),
) =>
  RunEnteredStep.make({
    eventId: runEventId(runId, `step:${step}`),
    runId,
    step,
    ...nodeField(node),
    enteredAt,
  });

const finishedStep = (step: {
  readonly runId: RunId;
  readonly step: string;
  readonly node: Option.Option<NodeRef>;
  readonly outcome: StepOutcome;
  readonly finishedAt: string;
}) =>
  RunFinishedStep.make({
    eventId: runEventId(step.runId, `step-finished:${step.step}`),
    runId: step.runId,
    step: step.step,
    ...nodeField(step.node),
    outcome: step.outcome,
    finishedAt: step.finishedAt,
  });

const enteredNode = (runId: RunId, node: NodeRef, enteredAt: string) =>
  RunEnteredNode.make({
    eventId: runEventId(runId, `node:${NodeRefs.keyOf(node)}`),
    runId,
    node,
    enteredAt,
  });

const finishedNode = (runId: RunId, node: NodeRef, outcome: StepOutcome, finishedAt: string) =>
  RunFinishedNode.make({
    eventId: runEventId(runId, `node-finished:${NodeRefs.keyOf(node)}`),
    runId,
    node,
    outcome,
    finishedAt,
  });

const tookBranch = (runId: RunId, node: NodeRef, outcome: string, takenAt: string) =>
  RunTookBranch.make({
    eventId: runEventId(runId, `branch:${NodeRefs.keyOf(node)}`),
    runId,
    node,
    outcome,
    takenAt,
  });

const reachedEnd = (runId: RunId, node: NodeRef, reachedAt: string) =>
  RunReachedEnd.make({
    eventId: runEventId(runId, `end:${NodeRefs.keyOf(node)}`),
    runId,
    node,
    reachedAt,
  });

const needsAttention = (wait: {
  readonly runId: RunId;
  readonly signal: string;
  readonly deferred: string;
  readonly parkedAt: string;
}) => RunNeedsAttention.make({ eventId: runEventId(wait.runId, `park:${wait.deferred}`), ...wait });

// A run that has ended; none for one still running.
const finished = (run: {
  readonly id: RunId;
  readonly status: RunStatus;
  readonly summary: Option.Option<string>;
  readonly finishedAt: Option.Option<string>;
}) =>
  Option.map(
    Option.filter(run.finishedAt, () => run.status !== "running"),
    (finishedAt) =>
      RunFinished.make({
        eventId: runEventId(run.id, "finished"),
        runId: run.id,
        status: run.status,
        summary: Option.getOrElse(run.summary, () => run.status),
        finishedAt,
      }),
  );

// The pull request a subject names; none for any other subject.
const pullRequestOpened = (run: { readonly id: RunId; readonly repo: string }, subject: string) =>
  Option.map(
    Option.filter(itemTarget(subject), (target) => target.kind === "pull-request"),
    (target) =>
      PullRequestOpened.make({
        eventId: runEventId(run.id, `subject:${subject}`),
        runId: run.id,
        repo: run.repo,
        number: target.number,
      }),
  );

// The events about where in its plan a run went.
export type NodeEvent = RunEnteredNode | RunFinishedNode | RunTookBranch | RunReachedEnd;

export const RunEvents = {
  started,
  enteredStep,
  finishedStep,
  enteredNode,
  finishedNode,
  tookBranch,
  reachedEnd,
  needsAttention,
  finished,
  pullRequestOpened,
} as const;
