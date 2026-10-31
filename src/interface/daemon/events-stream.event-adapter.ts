// What the dashboard and the TUI learn changes from: GET /events, a
// text/event-stream of one `snapshot` event holding what /status answers, then
// one event per event on the bus, and a ping comment every 15 seconds. An
// inbound adapter over the bus, as the socket is one over HTTP
// (docs/adr/0013-event-handlers.md).
//
// Each client subscribes to the bus before its snapshot is computed, so
// nothing that happens between the two is lost. Clients that connect within a
// second of each other share one computation of the snapshot, so several
// connecting at once don't hold up the daemon's ticks; one that joins a
// computation started before it subscribed is also sent what the bus said
// since it started, which it may then hear again under the same eventId. A
// client that reconnects gets a fresh snapshot; nothing is replayed by
// Last-Event-ID.

import { EventBus } from "@effect-server-utils/cqrs";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  type DaemonEvent,
  DaemonEvent as DaemonEventSchema,
  daemonEventTags,
  type DaemonReloading,
  DaemonStatus,
  type StatusChanged,
  type TickRan,
} from "./daemon.protocol.ts";

// How often an idle stream says it is still there.
export const PING_EVERY = Duration.seconds(15);

// How long after a snapshot's computation starts a client that connects
// shares it.
export const SNAPSHOT_SHARED_FOR = Duration.seconds(1);

// How many of the bus's events the feed keeps for a client that joins a
// computation started before it subscribed: far more than a second brings.
const KEPT = 1000;

// What the feed says to itself on the bus to know it has heard everything
// said before it: a tag no event on the bus has, so only the feed hears it.
const Checkpoint = Schema.TaggedStruct("chernabog/EventsCheckpoint", { id: Schema.Int });

const isCheckpoint = Schema.is(Checkpoint);
const isDaemonEvent = Schema.is(DaemonEventSchema);

// Says what the daemon itself says on the stream, to its clients alone: no
// handler on the bus reacts to these.
export const broadcastDaemonEvents = (
  events: ReadonlyArray<DaemonReloading | TickRan | StatusChanged>,
) => EventBus.use((bus) => bus.broadcast(events));

// Each on one line, as an event-stream's data must be.
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(DaemonEventSchema)));
const encodeStatus = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(DaemonStatus)));

const snapshotFrame = (status: DaemonStatus) =>
  `event: snapshot\ndata: ${encodeStatus(status)}\n\n`;

const eventFrame = (event: DaemonEvent) =>
  `event: ${event._tag}\nid: ${event.eventId}\ndata: ${encodeEvent(event)}\n\n`;

const PING = ": ping\n\n";

// One computation of the snapshot, which the clients that connect within
// SNAPSHOT_SHARED_FOR of its start share: when it started, the last event the
// feed had heard then, and its result.
type Computation<E> = {
  readonly startedAt: number;
  readonly from: number;
  readonly result: Deferred.Deferred<DaemonStatus, E>;
};

// The stream each client of /events reads, over `snapshot`, which /status
// answers too. It hears the bus for as long as the scope it's made in lasts,
// the daemon's.
export const openEventFeed = <E, R>(computeSnapshot: Effect.Effect<DaemonStatus, E, R>) =>
  Effect.gen(function* () {
    const bus = yield* EventBus;
    const scope = yield* Scope.Scope;
    const snapshot = Effect.provideContext(computeSnapshot, yield* Effect.context<R>());

    // What the bus said, numbered, for a client that joins a computation:
    // the last KEPT, and none from before the latest computation started.
    // A client takes its slice as it joins, before awaiting its snapshot.
    let heard = 0;
    let kept: Array<{ readonly seq: number; readonly event: DaemonEvent }> = [];
    const checkpoints = new Map<number, Deferred.Deferred<number>>();
    let latest = Option.none<Computation<E>>();

    const recorder = yield* bus.stream([...daemonEventTags, Checkpoint.fields._tag.schema.literal]);

    yield* Effect.forkIn(
      Stream.runForEach(recorder, (event) =>
        Effect.gen(function* () {
          if (isCheckpoint(event)) {
            const waiting = Option.fromUndefinedOr(checkpoints.get(event.id));
            checkpoints.delete(event.id);

            for (const deferred of Option.toArray(waiting)) {
              yield* Deferred.succeed(deferred, heard);
            }

            return;
          }

          if (!isDaemonEvent(event)) {
            return;
          }

          heard += 1;
          const from = Option.match(latest, { onNone: () => 0, onSome: (found) => found.from });
          kept = [...kept, { seq: heard, event }].filter((entry) => entry.seq > from).slice(-KEPT);
        }),
      ),
      scope,
    );

    // The number of the last event the bus said before now: every event said
    // before this is heard by then.
    let checkpointsSaid = 0;

    const caughtUp = Effect.gen(function* () {
      checkpointsSaid += 1;
      const id = checkpointsSaid;
      const deferred = yield* Deferred.make<number>();
      checkpoints.set(id, deferred);
      yield* bus.broadcast([Checkpoint.make({ id })]);

      return yield* Deferred.await(deferred);
    });

    // The computation a client that has heard up to `mark` shares: the latest,
    // if it started within SNAPSHOT_SHARED_FOR, or a new one. It runs in the
    // daemon's scope, so a client that leaves doesn't end it for the others.
    const computation = (mark: number) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        const shared = Option.filter(
          latest,
          (found) => now - found.startedAt < Duration.toMillis(SNAPSHOT_SHARED_FOR),
        );

        if (Option.isSome(shared)) {
          return shared.value;
        }

        const started: Computation<E> = {
          startedAt: now,
          from: mark,
          result: yield* Deferred.make<DaemonStatus, E>(),
        };

        latest = Option.some(started);

        // A computation that fails is shared no more, so a client that
        // connects again starts a fresh one rather than getting its failure.
        const forgetIfFailed = Effect.sync(() => {
          latest = Option.filter(latest, (found) => found !== started);
        });

        yield* Effect.forkIn(
          Deferred.into(snapshot.pipe(Effect.tapCause(() => forgetIfFailed)), started.result),
          scope,
        );

        return started;
      });

    const pings = Stream.tick(PING_EVERY).pipe(
      Stream.drop(1),
      Stream.map(() => PING),
    );

    // One client's stream: its own subscription, taken before the snapshot,
    // then the snapshot, then what the bus said since the computation it
    // shares started, then what the bus says. Ending it (the client
    // dropping) ends its subscription. A snapshot that fails ends it, and
    // the client connects again.
    const connect = Stream.unwrap(
      Effect.gen(function* () {
        const own = yield* bus.stream(daemonEventTags);
        const mark = yield* caughtUp;
        const shared = yield* computation(mark);

        // Taken now, while `kept` holds everything after the computation's
        // start: once a newer computation starts, the recorder keeps only
        // what came after it, and this one may still be running.
        const missed = kept
          .filter((entry) => entry.seq > shared.from && entry.seq <= mark)
          .map((entry) => entry.event);

        const sent = new Set(missed.map((event) => event.eventId));
        const status = yield* Deferred.await(shared.result);

        return Stream.make(snapshotFrame(status)).pipe(
          Stream.concat(Stream.fromIterable(missed.map(eventFrame))),
          Stream.concat(
            own.pipe(
              Stream.filter(isDaemonEvent),
              Stream.filter((event) => !sent.has(event.eventId)),
              Stream.map(eventFrame),
            ),
          ),
        );
      }),
    ).pipe(
      Stream.catchCause(() => Stream.empty),
      Stream.merge(pings, { haltStrategy: "left" }),
      Stream.encodeText,
    );

    return { connect };
  });

export type EventFeed = Effect.Success<ReturnType<typeof openEventFeed>>;

// GET /events, over a feed.
export const eventsRoute = (feed: EventFeed) =>
  HttpRouter.add(
    "GET",
    "/events",
    Effect.sync(() =>
      HttpServerResponse.stream(feed.connect, {
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
      }),
    ),
  );
