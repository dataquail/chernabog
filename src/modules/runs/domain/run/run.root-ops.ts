// The rules a run keeps: it starts running, takes steps while it runs, and
// ends exactly once; one persona has one run in flight per flow and item; and
// only a run from before personas is adopted by one. Each op takes the run as
// it is and returns it as it should be; storing it is the repository's job.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { type Persona, samePersona } from "../../../../kernel/persona.value-object.ts";
import { type RunId } from "../../../../kernel/run-id.id.ts";
import { RunAlreadyActive, RunAlreadyFinished } from "./run.errors.ts";
import { type RunEnding, RunRoot } from "./run.root.ts";

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
  readonly itemTitle: Option.Option<string>;
  readonly itemUrl: Option.Option<string>;
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

// The run entering a step.
const enterStep = (run: RunRoot, step: string) =>
  whileRunning(run, () => RunRoot.make({ ...run, currentStep: Option.some(step) }));

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

// A run from before personas, given the persona a repo's runs now act as, so
// it keeps resuming and holding that persona's slots. None for a run that
// already has a persona.
const adopt = (run: RunRoot, login: string) =>
  Option.map(
    Option.liftPredicate(run, (implicit) => Option.isNone(implicit.persona)),
    (implicit) => RunRoot.make({ ...implicit, persona: Option.some(login) }),
  );

export const RunRootOps = {
  isRunning,
  activeFor,
  start,
  attachExecution,
  enterStep,
  finish,
  adopt,
} as const;
