// The sandbox driver (ADR 22, decision 7): the domain layer over the real CLI
// and daemon in openSandbox (test/acceptance/sandbox.ts), against the fake
// GitHub (test/acceptance/fake-github.ts) and the fake gh, claude and codex in
// test/fakebin/. How it sets the machine up, acts and reads the world is
// what it shares with the ci driver (on-sandbox.ts).
//
// The driver starts the daemon only when the scenario first acts or looks,
// as the in-process driver makes its fake, and each persona's cast flows run
// every two seconds. Closing the scenario's scope stops the daemon this
// driver started, and the fake GitHub.
//
// A wait looks again every POLL_MS for up to WAIT_MS; settling waits until
// the daemon, asked for its status, has nothing running or queued and each
// of its flows has ticked IDLE_TICKS times with no run starting or ending.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import type { DaemonStatus } from "../../../src/interface/daemon/daemon.protocol.ts";
import type { Sandbox } from "../../acceptance/sandbox.ts";
import type { DomainFailed } from "../domain.ts";
import type { Driver } from "../runner.ts";
import { failed, openOn, worldOf } from "./on-sandbox.ts";

// How often a wait looks again, and how long it waits.
const POLL_MS = 250;
const WAIT_MS = 90_000;

// How many ticks of every flow, with nothing running, make the machine settled.
const IDLE_TICKS = 2;

// A persona's cast flows run every two seconds.
const OFTEN = { schedule: "*/2 * * * * *" };

type Running = {
  readonly sandbox: Sandbox;
  daemon: Option.Option<ReturnType<Sandbox["cli"]>>;
};

// Trusts the repo's .chernabog/ and starts the daemon, as a person does.
const daemonUp = (running: Running) =>
  Effect.gen(function* () {
    const { sandbox } = running;

    const trusted = yield* Effect.tryPromise({
      try: () => sandbox.runCli(["trust", "demo"]),
      catch: (error) => failed(`trust didn't run: ${String(error)}`),
    });

    if (trusted.code !== 0) {
      return yield* failed(`trust failed: ${trusted.output}`);
    }

    running.daemon = Option.some(sandbox.cli(["daemon"]));

    yield* Effect.tryPromise({
      try: () => sandbox.daemonReady(),
      catch: (error) => failed(`the daemon didn't start: ${String(error)}`),
    });
  });

// Stops the daemon this driver started, only it.
const stopped = ({ daemon, sandbox }: Running) =>
  Effect.forEach(
    Option.toArray(daemon),
    (child) => Effect.promise(() => sandbox.stopDaemon(child)),
    { discard: true },
  );

// The end of the daemon's log, for a failure to show what it did.
const logTail = ({ sandbox }: Running) =>
  `the daemon's log ends:\n${sandbox.daemonLog().split("\n").slice(-40).join("\n")}`;

// Looks with `find` every POLL_MS until it finds something, or fails with
// `why` once WAIT_MS have gone by.
const pollFor = <A>(
  running: Running,
  find: () => Effect.Effect<Option.Option<A>, DomainFailed>,
  why: () => string,
): Effect.Effect<A, DomainFailed> =>
  Effect.suspend(find).pipe(
    Effect.repeat({ schedule: Schedule.spaced(POLL_MS), until: Option.isSome }),
    Effect.timeoutOption(WAIT_MS),
    Effect.map(Option.flatten),
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () => Effect.fail(failed(`${why()}; ${logTail(running)}`)),
      }),
    ),
  );

const statusOf = ({ sandbox }: Running) =>
  Effect.tryPromise({
    try: () => sandbox.daemonStatus(),
    catch: (error) => failed(`the daemon's status couldn't be read: ${String(error)}`),
  });

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
// it would have done by then.
const settle = (running: Running) =>
  Effect.gen(function* () {
    let quiet = quietFrom(yield* statusOf(running), "nothing was seen yet");

    yield* pollFor(
      running,
      () =>
        Effect.map(statusOf(running), (status) => {
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

export const sandbox: Driver = {
  name: "sandbox",
  open: openOn<Running>({
    on: OFTEN,
    repoConfig: {},
    make: (opened) => ({ sandbox: opened, daemon: Option.none() }),
    start: daemonUp,
    stop: stopped,
    waitUntil: (running, description, find) =>
      pollFor(
        running,
        () => Effect.sync(() => find(worldOf(running.sandbox))),
        () => `waited ${WAIT_MS / 1000}s for ${description}`,
      ),
    settle,
  }),
  timeout: 240_000,
};
