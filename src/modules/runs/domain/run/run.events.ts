import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunStatus } from "./run-status.value-object.ts";
import { itemTarget } from "./work-item.value-object.ts";

// What happens to a run, as its commands tell whoever listens: the
// dashboard's /events stream, the notifier. A resumed workflow re-executes
// code, so a command dispatches one only after the write that makes it true,
// and each carries an id from its run and the step it is about: a repeat has
// the same id, for a consumer to drop.

// The id of an event about `step` of a run, such as "started" or "step:ci".
export const runEventId = (runId: RunId, step: string) => `${runId}:${step}`;

// A run recorded as starting, before its workflow does.
export const RunStarted = Schema.TaggedStruct("RunStarted", {
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
// step again tells no one.
export const RunEnteredStep = Schema.TaggedStruct("RunEnteredStep", {
  eventId: Schema.String,
  runId: RunId,
  step: Schema.String,
  enteredAt: Schema.String,
});

export type RunEnteredStep = typeof RunEnteredStep.Type;

// A run parked on a signal, such as a push to a review's pull request: it
// waits on someone, and holds no slot until it wakes.
export const RunNeedsAttention = Schema.TaggedStruct("RunNeedsAttention", {
  eventId: Schema.String,
  runId: RunId,
  signal: Schema.String,
  deferred: Schema.String,
  parkedAt: Schema.String,
});

export type RunNeedsAttention = typeof RunNeedsAttention.Type;

// A run ending, once, however it ended.
export const RunFinished = Schema.TaggedStruct("RunFinished", {
  eventId: Schema.String,
  runId: RunId,
  status: RunStatus,
  summary: Schema.String,
  finishedAt: Schema.String,
});

export type RunFinished = typeof RunFinished.Type;

// A run naming a pull request it opened as its subject, the first time it does.
export const PullRequestOpened = Schema.TaggedStruct("PullRequestOpened", {
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

const enteredStep = (runId: RunId, step: string, enteredAt: string) =>
  RunEnteredStep.make({ eventId: runEventId(runId, `step:${step}`), runId, step, enteredAt });

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

export const RunEvents = {
  started,
  enteredStep,
  needsAttention,
  finished,
  pullRequestOpened,
} as const;
