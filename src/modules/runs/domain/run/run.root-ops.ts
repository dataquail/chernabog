// The rules a run keeps: it starts running, takes steps while it runs, and
// ends exactly once; one persona has one run in flight per flow and item; and
// only a run from before personas is adopted by one. Each op takes the run as
// it is and returns it as it should be; storing it is the repository's job.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Result from "effect/Result";

import { type Persona, samePersona } from "../../../../kernel/persona.value-object.ts";
import { type RunId } from "../../../../kernel/run-id.id.ts";
import { supportsSdk, unsupportedRunSummary } from "../../../../kernel/sdk-support.value-object.ts";
import {
  AmbiguousRunPrefix,
  NoRunInFlight,
  RunAlreadyActive,
  RunAlreadyFinished,
  RunNotNamed,
  SeveralRunsInFlight,
} from "./run.errors.ts";
import { type RunEnding, RunRoot } from "./run.root.ts";
import { itemTarget, type WorkItem } from "./work-item.value-object.ts";

const isRunning = (run: RunRoot) => run.status === "running";

// What a run is for: a persona's run of a repo's flow on one work item.
export type RunFor = {
  readonly repo: string;
  readonly persona: Persona;
  readonly flow: string;
  readonly itemKey: string;
};

const isFor = (run: RunRoot, wanted: RunFor) =>
  run.repo === wanted.repo &&
  samePersona(run.persona, wanted.persona) &&
  run.flow === wanted.flow &&
  run.itemKey === wanted.itemKey;

// The persona's run in flight for the item, of `runs`.
const activeFor = (runs: ReadonlyArray<RunRoot>, wanted: RunFor) =>
  Arr.findFirst(runs, (run) => isRunning(run) && isFor(run, wanted));

export type NewRun = RunFor & {
  readonly id: RunId;
  readonly sdkVersion: string;
  readonly itemTitle: Option.Option<string>;
  readonly itemUrl: Option.Option<string>;
  readonly item: Option.Option<WorkItem>;
};

// A run starting at `at`, unless the persona already has one in flight for the
// item among `runs`.
const start = (runs: ReadonlyArray<RunRoot>, run: NewRun, at: string) =>
  Option.match(activeFor(runs, run), {
    onSome: (active) => Result.fail(new RunAlreadyActive({ runId: active.id })),
    onNone: () =>
      Result.succeed(
        RunRoot.make({
          ...run,
          executionId: Option.none(),
          status: "running",
          currentStep: Option.none(),
          summary: Option.none(),
          startedAt: at,
          finishedAt: Option.none(),
        }),
      ),
  });

const whileRunning = (run: RunRoot, change: () => RunRoot) => {
  if (!isRunning(run)) {
    return Result.fail(new RunAlreadyFinished({ runId: run.id, status: run.status }));
  }

  return Result.succeed(change());
};

// The workflow execution the engine started for the run.
const attachExecution = (run: RunRoot, executionId: string) =>
  whileRunning(run, () => RunRoot.make({ ...run, executionId: Option.some(executionId) }));

// A run a crash interrupted between being recorded and its workflow starting:
// still running, with no execution. None for any other run.
const unexecuted = (run: RunRoot) =>
  Option.liftPredicate(run, (found) => isRunning(found) && Option.isNone(found.executionId));

// Why this binary mustn't resume a run in flight: it started under an SDK
// this binary doesn't run, so replaying its journal under this one could do
// anything. None for a run it can resume, or one that has ended.
const unsupported = (run: RunRoot) =>
  Option.liftPredicate(
    unsupportedRunSummary(run.sdkVersion),
    () => isRunning(run) && !supportsSdk(run.sdkVersion),
  );

// The run entering a step.
const enterStep = (run: RunRoot, step: string) =>
  whileRunning(run, () => RunRoot.make({ ...run, currentStep: Option.some(step) }));

// The run opening or adopting a pull request for its work.
const linkPullRequest = (run: RunRoot, pullRequest: number) =>
  whileRunning(run, () => RunRoot.make({ ...run, pullRequest: Option.some(pullRequest) }));

// The run ending, at `at`, once: it's in no step after.
const finish = (run: RunRoot, ending: RunEnding, summary: string, at: string) =>
  whileRunning(run, () =>
    RunRoot.make({
      ...run,
      status: ending,
      summary: Option.some(summary),
      currentStep: Option.none(),
      finishedAt: Option.some(at),
    }),
  );

// The run ended by a person, at `at`, before its workflow could end it. Its
// summary says who and when, and the step it was interrupted in, if any.
const cancel = (run: RunRoot, by: string, at: string) =>
  whileRunning(run, () =>
    RunRoot.make({
      ...run,
      status: "cancelled",
      summary: Option.some(
        Option.match(run.currentStep, {
          onNone: () => `cancelled by ${by} at ${at}`,
          onSome: (step) => `cancelled by ${by} at ${at}, interrupted in ${step}`,
        }),
      ),
      currentStep: Option.none(),
      finishedAt: Option.some(at),
    }),
  );

// The run ended, at `at`, because its work item went while it was in flight
// (closed, merged, claimed by another run), before its workflow could end it.
// Its summary says why, and the step it was interrupted in, if any.
const supersede = (run: RunRoot, reason: string, at: string) =>
  whileRunning(run, () =>
    RunRoot.make({
      ...run,
      status: "superseded",
      summary: Option.some(
        Option.match(run.currentStep, {
          onNone: () => reason,
          onSome: (step) => `${reason}; interrupted in ${step}`,
        }),
      ),
      currentStep: Option.none(),
      finishedAt: Option.some(at),
    }),
  );

// What a person names a run in flight by, without its id: a repo's item, and
// optionally the flow and persona, when several runs in flight share the item.
export type InFlightQuery = {
  readonly repo: string;
  readonly itemKey: string;
  readonly flow: Option.Option<string>;
  readonly persona: Option.Option<string>;
};

// The one run in flight that `query` names, among `runs`.
const inFlightFor = (
  runs: ReadonlyArray<RunRoot>,
  query: InFlightQuery,
): Result.Result<RunRoot, NoRunInFlight | SeveralRunsInFlight> => {
  const matching = runs.filter(
    (run) =>
      isRunning(run) &&
      run.repo === query.repo &&
      run.itemKey === query.itemKey &&
      Option.match(query.flow, { onNone: () => true, onSome: (flow) => run.flow === flow }) &&
      Option.match(query.persona, {
        onNone: () => true,
        onSome: (login) => Option.contains(run.persona, login),
      }),
  );

  if (matching.length === 1) {
    return Result.succeed(matching[0]);
  }

  if (matching.length === 0) {
    return Result.fail(new NoRunInFlight({ repo: query.repo, itemKey: query.itemKey }));
  }

  return Result.fail(
    new SeveralRunsInFlight({
      repo: query.repo,
      itemKey: query.itemKey,
      matching: Arr.sort(
        matching.map((run) => run.id),
        Order.String,
      ),
    }),
  );
};

// The other runs in flight in the run's repo on the same issue or pull
// request, whatever their flow or persona: a review and a re-review of one
// pull request (`pr-<n>`, `pr-<n>-review-<k>`) share its checkout, so what one
// leaves behind the others may still be using. None for an item of a flow's own.
const sharingTarget = (runs: ReadonlyArray<RunRoot>, run: RunRoot) =>
  Option.match(itemTarget(run.itemKey), {
    onNone: (): ReadonlyArray<RunRoot> => [],
    onSome: (target) =>
      runs.filter(
        (other) =>
          isRunning(other) &&
          other.id !== run.id &&
          other.repo === run.repo &&
          Option.exists(
            itemTarget(other.itemKey),
            (theirs) => theirs.kind === target.kind && theirs.number === target.number,
          ),
      ),
  });

// A run from before personas, given the persona a repo's runs now act as, so
// it keeps resuming and holding that persona's slots. None for a run that
// already has a persona.
const adopt = (run: RunRoot, login: string) =>
  Option.map(
    Option.liftPredicate(run, (implicit) => Option.isNone(implicit.persona)),
    (implicit) => RunRoot.make({ ...implicit, persona: Option.some(login) }),
  );

// The run a person names by its id or, since ids are random, by enough of its
// start to tell it from every other, among `ids`. The ones a prefix matches
// are sorted, so an ambiguous one lists the same runs in the same order.
const named = (
  ids: ReadonlyArray<RunId>,
  asked: string,
): Result.Result<RunId, RunNotNamed | AmbiguousRunPrefix> => {
  const exact = Arr.findFirst(ids, (id) => id === asked);

  if (Option.isSome(exact)) {
    return Result.succeed(exact.value);
  }

  const matching = Arr.sort(
    ids.filter((id) => id.startsWith(asked)),
    Order.String,
  );

  if (matching.length === 1) {
    return Result.succeed(matching[0]);
  }

  if (matching.length === 0) {
    return Result.fail(new RunNotNamed({ asked }));
  }

  return Result.fail(new AmbiguousRunPrefix({ asked, matching }));
};

export const RunRootOps = {
  unsupported,
  named,
  isRunning,
  activeFor,
  start,
  attachExecution,
  unexecuted,
  enterStep,
  linkPullRequest,
  finish,
  cancel,
  supersede,
  inFlightFor,
  sharingTarget,
  adopt,
} as const;
