// How a driver over a real daemon waits (the sandbox driver, on the fake
// GitHub, and the live driver, on a real one): it looks again every so often
// until it finds what it waits for, and it settles once the daemon, asked
// for its status, has nothing running or queued and each of its flows has
// ticked IDLE_TICKS times with no run starting or ending.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import type { DaemonStatus } from "../../../src/interface/daemon/daemon.protocol.ts";
import { DomainFailed } from "../domain.ts";

const failed = (message: string) => new DomainFailed({ message });

// How many ticks of every flow, with nothing running, make the machine settled.
const IDLE_TICKS = 2;

export type Polling = {
  // How often a wait looks again, and how long it waits, in milliseconds.
  readonly pollMs: number;
  readonly waitMs: number;
  // What a failure adds, such as the end of the daemon's log.
  readonly tail: () => string;
};

// Looks with `find` every pollMs until it finds something, or fails with
// `why` once waitMs have gone by.
export const pollFor = <A>(
  polling: Polling,
  find: () => Effect.Effect<Option.Option<A>, DomainFailed>,
  why: () => string,
): Effect.Effect<A, DomainFailed> =>
  Effect.suspend(find).pipe(
    Effect.repeat({ schedule: Schedule.spaced(polling.pollMs), until: Option.isSome }),
    Effect.timeoutOption(polling.waitMs),
    Effect.map(Option.flatten),
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () => Effect.fail(failed(`${why()}; ${polling.tail()}`)),
      }),
    ),
  );

// What would make the machine not idle now: a run in flight that isn't
// parked, or work a flow that runs here found and hasn't started. A flow
// that's off (as a persona's flows outside the cast are) only skips its ticks.
const busyWith = (status: DaemonStatus) => [
  ...status.active
    .filter((run) => !run.parked)
    .map((run) => `${run.flow} ${run.itemKey} is running`),
  ...status.repos.flatMap((repo) =>
    repo.flows
      .filter((flow) => flow.enabled)
      .flatMap((flow) => [
        ...flow.queued.map((item) => `${flow.name} has ${item} queued`),
        ...Option.toArray(Option.fromUndefinedOr(flow.pending)).map(
          (event) => `${flow.name} has a tick due for ${event}`,
        ),
      ]),
  ),
];

// Which runs there are, so a run starting or ending between looks is seen.
const runsOf = (status: DaemonStatus) =>
  [...status.active.map((run) => `${run.id}:${run.parked}`), ...status.recent.map((run) => run.id)]
    .toSorted()
    .join(",");

const enabledFlows = (status: DaemonStatus) =>
  status.repos.flatMap((repo) =>
    repo.flows
      .filter((flow) => flow.enabled)
      .map((flow) => ({
        key: `${repo.name}/${flow.name}@${Option.getOrElse(Option.fromUndefinedOr(flow.persona), () => "")}`,
        lastTick: Option.getOrElse(flow.lastTick, () => ""),
      })),
  );

type Ticks = { readonly last: string; readonly count: number };

// The idle stretch so far: the runs it began with, each flow's last tick and
// how many it has had since, and what ended the stretch before it.
type Quiet = {
  readonly runs: string;
  readonly ticks: Map<string, Ticks>;
  readonly why: string;
};

const quietFrom = (status: DaemonStatus, why: string): Quiet => ({
  runs: runsOf(status),
  ticks: new Map(enabledFlows(status).map((flow) => [flow.key, { last: flow.lastTick, count: 0 }])),
  why,
});

const ticksOf = (quiet: Quiet, key: string, lastTick: string): Ticks =>
  Option.getOrElse(Option.fromUndefinedOr(quiet.ticks.get(key)), () => ({
    last: lastTick,
    count: 0,
  }));

// Whether the idle stretch has gone on long enough, counting the ticks `status` shows.
const settledAt = (quiet: Quiet, status: DaemonStatus) => {
  const flows = enabledFlows(status);

  for (const flow of flows) {
    const seen = ticksOf(quiet, flow.key, flow.lastTick);

    if (seen.last !== flow.lastTick) {
      quiet.ticks.set(flow.key, { last: flow.lastTick, count: seen.count + 1 });
    }
  }

  return (
    flows.length > 0 &&
    flows.every((flow) => ticksOf(quiet, flow.key, flow.lastTick).count >= IDLE_TICKS)
  );
};

// Waits until the daemon has had IDLE_TICKS ticks of every flow with nothing
// running or queued, and no run starting or ending: what it would do next,
// it would have done by then. `statusOf` is asked on every look.
export const settleDaemon = (
  polling: Polling,
  statusOf: Effect.Effect<DaemonStatus, DomainFailed>,
) =>
  Effect.gen(function* () {
    let quiet = quietFrom(yield* statusOf, "nothing was seen yet");

    yield* pollFor(
      polling,
      () =>
        Effect.map(statusOf, (status) => {
          const busy = busyWith(status);

          if (busy.length > 0 || runsOf(status) !== quiet.runs) {
            quiet = quietFrom(
              status,
              Arr.match(busy, {
                onEmpty: () => "a run started or ended",
                onNonEmpty: (found) => found.join("; "),
              }),
            );

            return Option.none();
          }

          return Option.liftPredicate(true, () => settledAt(quiet, status));
        }),
      () => `it never settled: last, ${quiet.why}`,
    );
  });
