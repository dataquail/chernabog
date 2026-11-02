// Lanes: the parallel lines of work in one run, as a page draws them. A
// step named `<name>#<id>` is in lane `<id>` (`implement#task-12` is in
// `task-12`); a step with no `#` is on the run's main line. A flow declares
// which lanes waited on which, so the page can draw an arrow from each lane
// to the ones it needed: the engine records them against the run and knows
// nothing of what a lane is.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// Records which lanes of a run waited on which. Provided by Chernabog.
export class RunLanes extends Context.Service<
  RunLanes,
  {
    // Adds `needs` to what `lane` waited on. Declaring it again, or a part of
    // it, changes nothing: a lane's needs only grow.
    declare(lane: string, needs: ReadonlyArray<string>): Effect.Effect<void>;
  }
>()("@chernabog/sdk/RunLanes") {}

// Declares that `lane` waited on each of `needs`, by the ids their steps
// carry after `#`: `declare("task-13", ["task-12"])`. Safe to repeat, so a
// workflow body, which runs again whenever its run resumes, may declare it
// again; what a lane needs is every lane any declaration named. Outside a run
// the engine records, it does nothing.
export const declare = (lane: string, needs: ReadonlyArray<string>) =>
  Effect.serviceOption(RunLanes).pipe(
    Effect.flatMap(
      Option.match({ onNone: () => Effect.void, onSome: (lanes) => lanes.declare(lane, needs) }),
    ),
  );
