// Flows and the durable building blocks inside them. A flow's workflow is an
// Effect that the daemon runs durably: every activity's result is saved, so after
// a crash or restart the workflow replays the saved results and continues after
// the last completed one. Side effects belong inside activities, never in the
// workflow body, because the body runs again on every replay.

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Activity from "effect/workflow/Activity";
import * as DurableClock from "effect/workflow/DurableClock";
import * as DurableDeferred from "effect/workflow/DurableDeferred";
import type * as WorkflowEngine from "effect/workflow/WorkflowEngine";

import {
  AgentError,
  GitError,
  GitHubError,
  NeedsHuman,
  type ReportedError,
  Skip,
  StepFailed,
  UsageError,
  WorkError,
} from "./errors.ts";
import type { Json } from "./json.ts";
import {
  type Agent,
  type Git,
  type GitHub,
  type Repo,
  type ReviewerSeat,
  type Run,
  RunLog,
  type Usage,
  type WorkItem,
  type Worktree,
} from "./services.ts";

// Runs a step from .chernabog/stages/ in its own process. Provided by Chernabog.
export class StepRunner extends Context.Service<
  StepRunner,
  {
    run(name: string, input: Json): Effect.Effect<Json, Skip | StepFailed>;
  }
>()("@chernabog/sdk/StepRunner") {}

// Records that a run waits on a signal, so the next tick's trigger can wake it. Provided by Chernabog.
export class Signals extends Context.Service<
  Signals,
  {
    register(signal: string, deferred: string, token: string): Effect.Effect<void>;
  }
>()("@chernabog/sdk/Signals") {}

export type TriggerServices =
  | Repo
  | GitHub
  | Git
  | Worktree
  | Usage
  | Agent
  | ReviewerSeat
  | RunLog
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner;

export type WorkflowServices =
  | TriggerServices
  | Run
  | StepRunner
  | Signals
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | Scope.Scope;

// What a flow's trigger, gate and workflow may fail with: the flow's own
// outcomes. Any other error must be handled, or mapped to one of these, before
// the flow compiles: a work error such as PushRejected by deciding what it
// means for the work, and an error the flow can only report with `reportAs`.
export type FlowError = Skip | NeedsHuman | StepFailed;

// A label a flow triggers on or sets beyond the repo's own, such as auto:ship. `chernabog labels` creates it.
export type FlowLabel = {
  readonly name: string;
  readonly color?: string;
  readonly description?: string;
};

export type Flow = {
  // The work items in the state this flow acts on, such as issues labelled auto:eligible.
  readonly trigger: Effect.Effect<ReadonlyArray<WorkItem>, FlowError, TriggerServices>;
  // Checked before each run starts; fail with Skip to hold the run back, such as on usage.
  readonly gate?: Effect.Effect<void, FlowError, TriggerServices>;
  // Runs of this flow in one repo at once. Defaults to 1; machine limits still apply.
  readonly concurrency?: number;
  // A cron schedule for the trigger, overriding the repo's default.
  readonly schedule?: string;
  // Labels of the flow's own, for `chernabog labels` to create.
  readonly labels?: ReadonlyArray<FlowLabel>;
  // Whether the trigger finds only the work of the persona it runs as, as
  // review's does by its review requests, so several personas can run the
  // flow without assignee or reviewRequested to tell them apart.
  readonly ownWork?: boolean;
  // The work item for a key a person names, when the trigger doesn't report
  // it: the issue `chernabog start` hands over, say. None when there is no such item.
  readonly item?: (
    key: string,
  ) => Effect.Effect<Option.Option<WorkItem>, FlowError, TriggerServices>;
  // The durable work for one item. Its result, if a string, is the run's summary.
  readonly workflow: (item: WorkItem) => Effect.Effect<string | void, FlowError, WorkflowServices>;
};

export const defineFlow = (flow: Flow): Flow => flow;

const FlowErrorSchema = Schema.Union([Skip, NeedsHuman, StepFailed]);

// What an activity may fail with, as its journal stores it: the flow's outcomes and the work's errors.
const ActivityError = Schema.Union([...FlowErrorSchema.members, ...WorkError.members]);
const isActivityError = Schema.is(ActivityError);

// An error's message, whatever shape it came in.
export const describeError = <E>(error: E): string => {
  if (Predicate.hasProperty(error, "step") && Predicate.hasProperty(error, "message")) {
    return `${String(error.step)}: ${String(error.message)}`;
  }

  if (Predicate.hasProperty(error, "message") && Predicate.isString(error.message)) {
    return error.message;
  }

  if (Predicate.hasProperty(error, "reason") && Predicate.isString(error.reason)) {
    return error.reason;
  }

  return String(error);
};

// Keeps the flow's outcomes and the work's errors, and names the activity in any other failure.
const toActivityError =
  (name: string) =>
  <E>(error: E): FlowError | WorkError => {
    if (isActivityError(error)) {
      return error;
    }

    return new StepFailed({ step: name, message: describeError(error) });
  };

const isReportedError = Schema.is(Schema.Union([GitHubError, GitError, AgentError, UsageError]));

const isReported = <E>(error: E): error is Extract<E, ReportedError> => isReportedError(error);

// Turns the errors a flow can only report (GitHubError, GitError, AgentError,
// UsageError) into StepFailed, named for `step`, and keeps every other error
// for the flow to handle. For a trigger, or work outside an activity, which
// does the same for its own.
export const reportAs =
  (step: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.catchIf(
      effect,
      isReported,
      (error) => Effect.fail(new StepFailed({ step, message: error.message })),
      (other) => Effect.fail(other),
    );

const withRunLog = (use: (log: RunLog["Service"]) => Effect.Effect<void>) =>
  Effect.serviceOption(RunLog).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: use })),
  );

// An activity's journal holds any of the flow's outcomes and work errors, but
// an activity only ever fails with the outcomes and the work errors its own
// execute raised: toActivityError keeps no others, and a replay reads back
// what it kept. So a failure that is an activity error is one of E's.
const raisedBy =
  <E>() =>
  (error: FlowError | WorkError): error is FlowError | Extract<E, WorkError> =>
    isActivityError(error);

const narrowed =
  <E>(name: string) =>
  <A, R>(effect: Effect.Effect<A, FlowError | WorkError, R>) =>
    Effect.catchIf(effect, raisedBy<E>(), Effect.fail, (other) =>
      Effect.fail(new StepFailed({ step: name, message: describeError(other) })),
    );

// One durable step of a workflow. It runs once; its result is saved, and a
// replay returns the saved result. Names must be unique within a run, so a
// step inside a loop carries its round: `fix-ci-2`. `success` is the result's
// schema, which the journal stores it with; leave it out for a step that
// returns nothing. It fails with the flow's outcomes and the work's errors
// it raised, which the flow handles; any other failure is StepFailed.
export const activity = <S extends Schema.Constraint = typeof Schema.Void, E = never, R = never>(
  name: string,
  execute: Effect.Effect<S["Type"], E, R>,
  success?: S,
) =>
  narrowed<E>(name)(
    Activity.make({
      name,
      success,
      error: ActivityError,
      execute: withRunLog((log) => log.step(name)).pipe(
        Effect.andThen(execute),
        Effect.ensuring(withRunLog((log) => log.stepDone(name))),
        Effect.mapError(toActivityError(name)),
      ),
    }),
  );

// Runs .chernabog/stages/<name>.ts (or an executable <name>) in a child
// process, checks its output against `output`, and saves the result. `id`
// tells apart two runs of one step in a run.
export const step = <A>(
  name: string,
  input: Json,
  output: Schema.Codec<A, Json>,
  id: Option.Option<string> = Option.none(),
) =>
  activity(
    Option.match(id, { onNone: () => name, onSome: (suffix) => `${name}#${suffix}` }),
    StepRunner.use((runner) => runner.run(name, input)).pipe(
      Effect.flatMap((raw) =>
        Schema.decodeEffect(output)(raw).pipe(
          Effect.mapError(
            (issue) => new StepFailed({ step: name, message: `output: ${issue.message}` }),
          ),
        ),
      ),
    ),
    output,
  );

// A durable pause: it survives restarts, and a timer that came due while the
// daemon was down fires as soon as it is back.
export const sleep = (name: string, duration: Duration.Input) =>
  DurableClock.sleep({ name, duration, inMemoryThreshold: Duration.zero });

// The durable deferred behind one wait, by name. Chernabog completes it with `true` when the signal comes.
export const signalDeferred = (name: string) =>
  DurableDeferred.make(name, { success: Schema.Literal(true) });

export type Wait = { readonly id: string; readonly timeout: Duration.Input };

// Waits for whichever comes first: one of the signals, which a trigger reports
// for this run's work item (see WorkItem.signals), or the timeout. Returns the
// signal's name, or "timeout". `id` makes each wait in a loop distinct:
// `awaitSignal(["pushed", "closed"], { id: "round-2", timeout: "6 hours" })`.
export const awaitSignal = (signals: ReadonlyArray<string>, wait: Wait) =>
  Effect.gen(function* () {
    const waits = signals.map((signal) => ({
      signal,
      deferred: signalDeferred(`${signal}:${wait.id}`),
    }));

    for (const pending of waits) {
      const token = yield* DurableDeferred.token(pending.deferred);
      yield* activity(
        `await-${pending.deferred.name}`,
        Signals.use((registry) => registry.register(pending.signal, pending.deferred.name, token)),
      );
    }

    const [first, ...rest] = [
      ...waits.map((pending) =>
        DurableDeferred.await(pending.deferred).pipe(Effect.as(pending.signal)),
      ),
      sleep(`timeout:${wait.id}`, wait.timeout).pipe(Effect.as("timeout")),
    ];

    return yield* DurableDeferred.raceAll({
      name: `race:${wait.id}`,
      success: Schema.String,
      error: Schema.Never,
      effects: [first, ...rest],
    });
  });
