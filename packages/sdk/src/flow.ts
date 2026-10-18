// Flows and the durable building blocks inside them. A flow's workflow is an
// Effect that the daemon runs durably: every activity's result is saved, so after
// a crash or restart the workflow replays the saved results and continues after
// the last completed one. Side effects belong inside activities, never in the
// workflow body, because the body runs again on every replay.

import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import type * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import type * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';
import * as Schema from 'effect/Schema';
import type * as Scope from 'effect/Scope';
import * as Activity from 'effect/workflow/Activity';
import * as DurableClock from 'effect/workflow/DurableClock';
import * as DurableDeferred from 'effect/workflow/DurableDeferred';
import type * as WorkflowEngine from 'effect/workflow/WorkflowEngine';

import { NeedsHuman, Skip, StepFailed } from './errors.ts';
import type { Json } from './json.ts';
import { type Agent, type Git, type GitHub, type Repo, type Run, RunLog, type Usage, type WorkItem, type Worktree } from './services.ts';

// Runs a step from .chernabog/stages/ in its own process. Provided by Chernabog.
export class StepRunner extends Context.Service<
  StepRunner,
  {
    run(name: string, input: Json): Effect.Effect<Json, Skip | StepFailed>;
  }
>()('@chernabog/sdk/StepRunner') {}

// Records that a run waits on a signal, so the next tick's trigger can wake it. Provided by Chernabog.
export class Signals extends Context.Service<
  Signals,
  {
    register(signal: string, deferred: string, token: string): Effect.Effect<void>;
  }
>()('@chernabog/sdk/Signals') {}

export type TriggerServices = Repo | GitHub | Git | Worktree | Usage | Agent | RunLog | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner;

export type WorkflowServices =
  | TriggerServices
  | Run
  | StepRunner
  | Signals
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | Scope.Scope;

export type FlowError = Skip | NeedsHuman | StepFailed;

// What a flow's trigger, gate and workflow may fail with: anything, which the engine reports by its message.
export type FlowFailure = { readonly _tag: string } | Error;

export type Flow = {
  // The work items in the state this flow acts on, such as issues labelled auto:eligible.
  readonly trigger: Effect.Effect<ReadonlyArray<WorkItem>, FlowFailure, TriggerServices>;
  // Checked before each run starts; fail with Skip to hold the run back, such as on usage.
  readonly gate?: Effect.Effect<void, FlowFailure, TriggerServices>;
  // Runs of this flow in one repo at once. Defaults to 1; machine limits still apply.
  readonly concurrency?: number;
  // A cron schedule for the trigger, overriding the repo's default.
  readonly schedule?: string;
  // The durable work for one item. Its result, if a string, is the run's summary.
  readonly workflow: (item: WorkItem) => Effect.Effect<string | void, FlowFailure, WorkflowServices>;
};

export const defineFlow = (flow: Flow): Flow => flow;

const FlowErrorSchema = Schema.Union([Skip, NeedsHuman, StepFailed]);
const isFlowError = Schema.is(FlowErrorSchema);

// An error's message, whatever shape it came in.
export const describeError = <E>(error: E): string => {
  if (Predicate.hasProperty(error, 'step') && Predicate.hasProperty(error, 'message')) return `${String(error.step)}: ${String(error.message)}`;

  if (Predicate.hasProperty(error, 'message') && Predicate.isString(error.message)) return error.message;

  if (Predicate.hasProperty(error, 'reason') && Predicate.isString(error.reason)) return error.reason;

  return String(error);
};

// Keeps the SDK's own outcomes, and names the activity in any other failure.
const toFlowError =
  (name: string) =>
  <E>(error: E): FlowError => {
    if (isFlowError(error)) return error;

    return new StepFailed({ step: name, message: describeError(error) });
  };

const withRunLog = (use: (log: RunLog['Service']) => Effect.Effect<void>) =>
  Effect.serviceOption(RunLog).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: use })));

// One durable step of a workflow. It runs once; its result is saved, and a
// replay returns the saved result. Names must be unique within a run, so a
// step inside a loop carries its round: `fix-ci-2`. `success` is the result's
// schema, which the journal stores it with; leave it out for a step that
// returns nothing.
export const activity = <S extends Schema.Constraint = typeof Schema.Void, E = never, R = never>(name: string, execute: Effect.Effect<S['Type'], E, R>, success?: S) =>
  Activity.make({
    name,
    success,
    error: FlowErrorSchema,
    execute: withRunLog((log) => log.step(name)).pipe(
      Effect.andThen(execute),
      Effect.ensuring(withRunLog((log) => log.stepDone(name))),
      Effect.mapError(toFlowError(name)),
    ),
  });

// Runs .chernabog/stages/<name>.ts (or an executable <name>) in a child
// process, checks its output against `output`, and saves the result. `id`
// tells apart two runs of one step in a run.
export const step = <A>(name: string, input: Json, output: Schema.Codec<A, Json>, id: Option.Option<string> = Option.none()) =>
  activity(
    Option.match(id, { onNone: () => name, onSome: (suffix) => `${name}#${suffix}` }),
    StepRunner.use((runner) => runner.run(name, input)).pipe(
      Effect.flatMap((raw) => Schema.decodeEffect(output)(raw).pipe(Effect.mapError((issue) => new StepFailed({ step: name, message: `output: ${issue.message}` })))),
    ),
    output,
  );

// A durable pause: it survives restarts, and a timer that came due while the
// daemon was down fires as soon as it is back.
export const sleep = (name: string, duration: Duration.Input) => DurableClock.sleep({ name, duration, inMemoryThreshold: Duration.zero });

// The durable deferred behind one wait, by name. Chernabog completes it with `true` when the signal comes.
export const signalDeferred = (name: string) => DurableDeferred.make(name, { success: Schema.Literal(true) });

export type Wait = { readonly id: string; readonly timeout: Duration.Input };

// Waits for whichever comes first: one of the signals, which a trigger reports
// for this run's work item (see WorkItem.signals), or the timeout. Returns the
// signal's name, or "timeout". `id` makes each wait in a loop distinct:
// `awaitSignal(["pushed", "closed"], { id: "round-2", timeout: "6 hours" })`.
export const awaitSignal = (signals: ReadonlyArray<string>, wait: Wait) =>
  Effect.gen(function* () {
    const waits = signals.map((signal) => ({ signal, deferred: signalDeferred(`${signal}:${wait.id}`) }));

    for (const pending of waits) {
      const token = yield* DurableDeferred.token(pending.deferred);
      yield* activity(`await-${pending.deferred.name}`, Signals.use((registry) => registry.register(pending.signal, pending.deferred.name, token)));
    }

    const [first, ...rest] = [
      ...waits.map((pending) => DurableDeferred.await(pending.deferred).pipe(Effect.as(pending.signal))),
      sleep(`timeout:${wait.id}`, wait.timeout).pipe(Effect.as('timeout')),
    ];

    return yield* DurableDeferred.raceAll({ name: `race:${wait.id}`, success: Schema.String, error: Schema.Never, effects: [first, ...rest] });
  });
