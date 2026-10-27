// The rules a wait keeps. A run that waits on several signals at once, as
// awaitSignal(["approved", "changes-requested"], { id }) does, parks one wait
// per signal, each a deferred named `<signal>:<id>`; the first to come wins the
// race, and the others are done with it.

import { type RunWaitRoot } from "./run-wait.root.ts";

// The race a wait is part of: its deferred's name without the signal.
const raceOf = (wait: RunWaitRoot) => {
  const prefix = `${wait.signal}:`;

  if (wait.deferred.startsWith(prefix)) {
    return wait.deferred.slice(prefix.length);
  }

  return wait.deferred;
};

// The run's other waits in the race the woken one won, which nothing will wake now.
const losersTo = (woken: RunWaitRoot, waits: ReadonlyArray<RunWaitRoot>) =>
  waits.filter(
    (wait) =>
      wait.runId === woken.runId &&
      wait.deferred !== woken.deferred &&
      raceOf(wait) === raceOf(woken),
  );

export const RunWaitRootOps = { raceOf, losersTo };
