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
// the daemon is idle, as daemon-settle.ts says.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { Sandbox } from "../../acceptance/sandbox.ts";
import type { Driver } from "../runner.ts";
import { pollFor, type Polling, settleDaemon } from "./daemon-settle.ts";
import { failed, openOn, worldOf } from "./on-sandbox.ts";

// How often a wait looks again, and how long it waits.
const POLL_MS = 250;
const WAIT_MS = 90_000;

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

// How a wait polls: a failure shows the end of the daemon's log.
const pollingOf = ({ sandbox }: Running): Polling => ({
  pollMs: POLL_MS,
  waitMs: WAIT_MS,
  tail: () => `the daemon's log ends:\n${sandbox.daemonLog().split("\n").slice(-40).join("\n")}`,
});

const statusOf = ({ sandbox }: Running) =>
  Effect.tryPromise({
    try: () => sandbox.daemonStatus(),
    catch: (error) => failed(`the daemon's status couldn't be read: ${String(error)}`),
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
        pollingOf(running),
        () => Effect.sync(() => find(worldOf(running.sandbox))),
        () => `waited ${WAIT_MS / 1000}s for ${description}`,
      ),
    settle: (running) => settleDaemon(pollingOf(running), statusOf(running)),
  }),
  timeout: 240_000,
};
