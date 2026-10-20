// Steps on a pull request that any flow can use, whichever flow opened it. A
// flow that reviews and fixes a pull request itself owns it while it works, so
// the standalone review and fix flows leave it alone.

import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';

import { commentStep } from './comment.ts';
import { activity } from './flow.ts';
import { latestMarker, type OwnerMarker, ownerMarker } from './markers.ts';
import { GitHub, Run, Runs } from './services.ts';

const writeOwner = (name: string, pullRequest: number, released: boolean) =>
  activity(
    name,
    Effect.gen(function* () {
      const run = yield* Run;
      const marker = ownerMarker.write({ flow: run.flow, runId: run.runId, released });

      if (released) yield* (yield* GitHub).comment(pullRequest, `The \`${run.flow}\` run is done with this pull request. ${marker}`);
      else yield* (yield* GitHub).comment(pullRequest, `The \`${run.flow}\` run owns this pull request until it ends. ${marker}`);
    }),
  );

// Comments on the pull request, and does nothing else.
export const comment = (pullRequest: number, body: string) => commentStep('pr', pullRequest, body);

// Marks the pull request as this run's.
export const own = (pullRequest: number) => writeOwner(`own-pr-${pullRequest}`, pullRequest, false);

// Lets the pull request go, so the standalone flows pick it up again.
export const release = (pullRequest: number) => writeOwner(`release-pr-${pullRequest}`, pullRequest, true);

// Owns the pull request for as long as `effect` runs, and releases it however
// that ends. A run waiting on a signal keeps it.
export const owning =
  (pullRequest: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    own(pullRequest).pipe(
      Effect.andThen(effect),
      // A wait suspends the run by interrupting it; that is not an ending.
      Effect.onExit((exit) => {
        if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) return Effect.void;

        return release(pullRequest).pipe(Effect.ignore);
      }),
    );

// The run that owns the pull request, from its comments: none once it let go,
// or when this machine knows the run has ended.
export const ownerOf = (bodies: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const latest = Option.filter(latestMarker(ownerMarker.read, bodies), (marker) => !marker.released);

    if (Option.isNone(latest)) return Option.none<OwnerMarker>();

    const runs = yield* Effect.serviceOption(Runs);
    const active = yield* Option.match(runs, { onNone: () => Effect.succeedNone, onSome: (known) => known.isActive(latest.value.runId) });

    if (Option.contains(active, false)) return Option.none<OwnerMarker>();

    return latest;
  });
