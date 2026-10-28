// Markers: what a run put on an item outside chernabog, such as a label or an
// assignment, each with a named way to take it off. A run holds a marker by
// its definition's name, with JSON arguments, and the engine records the hold
// against the run. However the run ends (done, failed, needs-human,
// cancelled, superseded), the engine releases each marker it still holds,
// newest first, by calling the definition's release with those arguments,
// from the flow as the base branch has it then. A closure can't be journaled,
// so a release is defined by name, at the top of a flow module, and listed in
// the flow's `markers`; the SDK's own (Markers.builtIn) need no listing.
//
// A release must be safe to repeat: one that fails is retried, with backoff,
// and one interrupted by a crash runs again.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

import { StepFailed } from "./errors.ts";
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
  type Worktree,
} from "./services.ts";

// How a run can end, for a marker that stays on some endings.
export type Ending = "done" | "skipped" | "needs-human" | "failed" | "cancelled" | "superseded";

// What a release may use: a trigger's services (flow.ts' TriggerServices), as
// the run's persona, and Run, naming the run that held the marker.
export type ReleaseServices =
  | Repo
  | GitHub
  | Git
  | Worktree
  | Usage
  | Agent
  | ReviewerSeat
  | RunLog
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | Run;

// A marker's release, with its arguments as the engine stores them, JSON. It
// fails with ArgumentsChanged when they no longer fit the definition's schema.
export type Marker = {
  readonly name: string;
  readonly releaseJson: (
    args: Json,
  ) => Effect.Effect<void, ArgumentsChanged | unknown, ReleaseServices>;
};

// A named way to take a marker off. `args` is the schema of the arguments a
// hold gives, which the engine stores as JSON and decodes again to release it.
export type Definition<A> = Marker & {
  readonly args: Schema.Codec<A, Json>;
  readonly release: (args: A) => Effect.Effect<void, unknown, ReleaseServices>;
};

// A hold's stored arguments don't fit the marker's schema any more: the flow
// changed the marker's shape since the run held it.
export class ArgumentsChanged extends Schema.TaggedError<
  ArgumentsChanged,
  { readonly brand: "ArgumentsChanged" }
>()("ArgumentsChanged", {
  message: Schema.String,
}) {}

// Defines a marker's release by name, unique among the flow's markers. Keep a
// name, and its arguments' shape, once runs hold it: a run in flight is
// released by the name it held, with the arguments it gave.
export const define = <A>(
  name: string,
  args: Schema.Codec<A, Json>,
  release: (args: A) => Effect.Effect<void, unknown, ReleaseServices>,
): Definition<A> => ({
  name,
  args,
  release,
  releaseJson: (json) =>
    Schema.decodeEffect(args)(json).pipe(
      Effect.mapError(
        (issue) => new ArgumentsChanged({ message: `${name} arguments: ${issue.message}` }),
      ),
      Effect.flatMap(release),
    ),
});

export type HoldOptions = {
  // The endings on which the marker stays, such as needs-human for something
  // put there for a person to see.
  readonly keepOn?: ReadonlyArray<Ending>;
};

// Records what a run holds, for the engine to release when it ends. Provided by Chernabog.
export class MarkerHolds extends Context.Service<
  MarkerHolds,
  {
    // Fails when the flow doesn't list the marker, which the engine couldn't release.
    hold(name: string, args: Json, keepOn: ReadonlyArray<Ending>): Effect.Effect<void, StepFailed>;
    // The arguments of each hold the run has of `name`.
    held(name: string): Effect.Effect<ReadonlyArray<Json>>;
    // Forgets a hold, once it is released.
    forget(name: string, args: Json): Effect.Effect<void>;
  }
>()("@chernabog/sdk/MarkerHolds") {}

// Uses the run's holds; outside a run the engine records, does nothing.
const withHolds = <E, R>(use: (holds: MarkerHolds["Service"]) => Effect.Effect<void, E, R>) =>
  Effect.serviceOption(MarkerHolds).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: use })),
  );

const encoded = <A>(marker: Definition<A>, args: A) =>
  Schema.encodeEffect(marker.args)(args).pipe(
    Effect.mapError(
      (issue) =>
        new StepFailed({ step: "hold", message: `${marker.name} arguments: ${issue.message}` }),
    ),
  );

// Holds a marker for this run, so the engine releases it however the run
// ends. Hold it before putting it on, so a crash in between leaves nothing
// unrecorded. Holding it again with the same arguments changes nothing, so a
// run that resumes doesn't hold it twice. Outside a run the engine records,
// it does nothing.
export const hold = <A>(marker: Definition<A>, args: A, options: HoldOptions = {}) =>
  encoded(marker, args).pipe(
    Effect.flatMap((json) =>
      withHolds((holds) => holds.hold(marker.name, json, options.keepOn ?? [])),
    ),
  );

// Forgets a hold the run has let go of itself, so the engine doesn't release it.
export const forget = <A>(marker: Definition<A>, args: A) =>
  encoded(marker, args).pipe(
    Effect.flatMap((json) => withHolds((holds) => holds.forget(marker.name, json))),
  );

const note = (message: string) =>
  Effect.serviceOption(RunLog).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (log) => log.log(message) })),
  );

// Releases one hold now, and forgets it; a release that fails stays held.
const releaseNow = <A>(marker: Definition<A>, args: A, json: Json) =>
  marker.release(args).pipe(
    Effect.matchEffect({
      onSuccess: () => withHolds((holds) => holds.forget(marker.name, json)),
      onFailure: (error) =>
        note(
          `releasing ${marker.name} failed, so it is released when the run ends: ${String(error)}`,
        ).pipe(
          Effect.andThen(withHolds((holds) => holds.hold(marker.name, json, []))),
          Effect.ignore,
        ),
    }),
  );

// Releases a marker now, when the run is done with it, whether or not this
// run held it. A release that fails is left held, for the engine to release
// when the run ends.
export const drop = <A>(marker: Definition<A>, args: A) =>
  encoded(marker, args).pipe(Effect.flatMap((json) => releaseNow(marker, args, json)));

// Releases now every hold of a marker the run has, as drop does each.
export const dropAll = <A>(marker: Definition<A>) =>
  withHolds((holds) =>
    holds.held(marker.name).pipe(
      Effect.flatMap((held) =>
        Effect.forEach(
          held,
          (json) =>
            Option.match(Schema.decodeOption(marker.args)(json), {
              onNone: () => Effect.void,
              onSome: (args) => releaseNow(marker, args, json),
            }),
          { discard: true },
        ),
      ),
    ),
  );

// The definition named `name` among `markers`.
export const find = (markers: ReadonlyArray<Marker>, name: string) =>
  Option.fromUndefinedOr(markers.find((marker) => marker.name === name));

// Says why a hold the engine couldn't release fails.
export const unlisted = (name: string) =>
  new StepFailed({
    step: "hold",
    message: `marker ${name} isn't among the flow's markers; add it to defineFlow's markers`,
  });
