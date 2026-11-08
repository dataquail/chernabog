// The hooks a run's page follows the daemon through: the run, loaded again
// when the daemon says it entered a step, parked or finished (or when its
// event stream connects again, having maybe missed one), and its log.

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { useEffect, useState } from "react";

import { daemonFeed } from "./feed.ts";
import { REFETCH_AT_MOST_EVERY } from "./live.ts";
import { type Detail, loadDetail, refetchesFor } from "./run.ts";
import {
  hearLog,
  initialLog,
  type LogHeard,
  type LogNode,
  type LogState,
  runLogFeed,
} from "./run-log.ts";

// How long the page waits to connect again to a stream that dropped.
const RECONNECT_AFTER = Duration.seconds(2);

// Loads the run asked for, then again for each event about it, telling
// `onDetail` each time.
export const followRun = (
  origin: string,
  asked: string,
  onDetail: (detail: Detail) => void,
): Effect.Effect<void, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const first = yield* loadDetail(origin, asked);

    yield* Effect.sync(() => {
      onDetail(first);
    });

    if (first.kind !== "found") {
      return;
    }

    const runId = first.run.id;

    // A load that fails keeps what the page shows.
    const reload = loadDetail(origin, runId).pipe(
      Effect.flatMap((detail) =>
        Effect.sync(() => {
          if (detail.kind === "found") {
            onDetail(detail);
          }
        }),
      ),
    );

    const listen = daemonFeed(origin).pipe(
      Stream.filter((heard) => heard.kind === "snapshot" || refetchesFor(heard, runId)),
      Stream.debounce(REFETCH_AT_MOST_EVERY),
      Stream.runForEach(() => reload),
      Effect.ignore,
    );

    return yield* Effect.forever(Effect.andThen(listen, Effect.sleep(RECONNECT_AFTER)));
  });

// Follows the run's log until its stream ends with the run, telling `onHeard`
// what each connection says, and when one drops before its end.
export const followRunLog = (
  origin: string,
  runId: string,
  onHeard: (heard: LogHeard) => void,
  step: Option.Option<string> = Option.none(),
  node: Option.Option<LogNode> = Option.none(),
): Effect.Effect<void, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const ended = yield* Ref.make(false);

    const told = (heard: LogHeard) =>
      Effect.andThen(
        Ref.set(ended, heard.kind === "end"),
        Effect.sync(() => {
          onHeard(heard);
        }),
      );

    const connection = Stream.runForEach(runLogFeed(origin, runId, step, node), told).pipe(
      Effect.ignore,
      Effect.andThen(Ref.get(ended)),
      Effect.tap((done) => Effect.when(told({ kind: "dropped" }), Effect.succeed(!done))),
    );

    yield* Effect.repeat(connection, {
      schedule: Schedule.spaced(RECONNECT_AFTER),
      while: (done) => !done,
    });
  });

// Runs `following` until the component goes, or what it follows changes.
const runUntilGone = (following: Effect.Effect<void, never, HttpClient.HttpClient>) => {
  const fiber = Effect.runFork(following.pipe(Effect.provide(FetchHttpClient.layer)));

  return () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
};

// The run the page was asked for, as the daemon that served it answers.
export const useRunDetail = (origin: string, asked: string): Detail => {
  const [detail, setDetail] = useState<Detail>({ kind: "loading" });

  useEffect(() => {
    setDetail({ kind: "loading" });

    return runUntilGone(followRun(origin, asked, setDetail));
  }, [origin, asked]);

  return detail;
};

// The run's log, or the one step's of it the daemon keeps, as the page holds it.
export const useRunLog = (
  origin: string,
  runId: string,
  step: Option.Option<string> = Option.none(),
  // Whether the page shows other logs in its place, and follows none.
  idle = false,
): LogState => {
  const [log, setLog] = useState<LogState>(initialLog);
  const stepName = Option.getOrElse(step, () => "");

  useEffect(() => {
    setLog(initialLog);

    if (idle) {
      return;
    }

    return runUntilGone(
      followRunLog(
        origin,
        runId,
        (heard) => {
          setLog((held) => hearLog(held, heard));
        },
        Option.liftPredicate(stepName, (name) => name !== ""),
      ),
    );
  }, [origin, runId, stepName, idle]);

  return log;
};

// One engine step's log, at the plan node it ran at, as a node's page shows
// it; a step that ran at no node, as set up's and wrap up's do, by its name alone.
export const useStepLog = (
  origin: string,
  runId: string,
  step: string,
  node: Option.Option<LogNode>,
): LogState => {
  const [log, setLog] = useState<LogState>(initialLog);

  const id = Option.getOrElse(
    Option.map(node, (at) => at.id),
    () => "",
  );

  const round = Option.getOrElse(
    Option.flatMap(node, (at) => Option.fromUndefinedOr(at.round)),
    () => -1,
  );

  const lane = Option.getOrElse(
    Option.flatMap(node, (at) => Option.fromUndefinedOr(at.lane)),
    () => "",
  );

  useEffect(() => {
    setLog(initialLog);

    const at = Option.map(
      Option.liftPredicate(id, (kept) => kept !== ""),
      (kept): LogNode => ({
        id: kept,
        ...Option.match(
          Option.liftPredicate(round, (held) => held >= 0),
          {
            onNone: () => ({}),
            onSome: (held) => ({ round: held }),
          },
        ),
        ...Option.match(
          Option.liftPredicate(lane, (held) => held !== ""),
          {
            onNone: () => ({}),
            onSome: (held) => ({ lane: held }),
          },
        ),
      }),
    );

    return runUntilGone(
      followRunLog(
        origin,
        runId,
        (heard) => {
          setLog((held) => hearLog(held, heard));
        },
        Option.some(step),
        at,
      ),
    );
  }, [origin, runId, step, id, round, lane]);

  return log;
};
