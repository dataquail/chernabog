import { describe, expect } from "bun:test";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { effect } from "../../../test/effect-test.ts";
import { CountedStreamsBus, OpenStreams } from "../../../test/events.ts";
import { RunId } from "../../kernel/run-id.id.ts";
import { EngineAt, RunsCommands } from "../../modules/runs/runs.platform.ts";
import { Home, homePaths } from "../../platform/home.ts";
import { applicationModules } from "../application-modules.ts";
import { DaemonEvent, DaemonStatus, StatusChanged } from "./daemon.protocol.ts";
import {
  broadcastDaemonEvents,
  eventsRoute,
  openEventFeed,
  SNAPSHOT_SHARED_FOR,
} from "./events-stream.event-adapter.ts";

// The modules a daemon adds, over a runtime with no flows and a state.db in a
// scratch home, on one bus that counts its streams.
const daemonInScratch = Layer.unwrap(
  FileSystem.FileSystem.use((fs) =>
    fs.makeTempDirectoryScoped({ prefix: "chernabog-events-" }),
  ).pipe(
    Effect.map((home) =>
      applicationModules.engine.pipe(
        Layer.provide(applicationModules.runtime({ handles: [], services: () => Option.none() })),
        Layer.provideMerge(CountedStreamsBus),
        Layer.provide(EngineAt(homePaths(home).state)),
        Layer.provide(Home.at(home, home)),
      ),
    ),
  ),
);

const status = DaemonStatus.make({
  pid: 1,
  startedAt: "2026-10-31T00:00:00.000Z",
  busy: 0,
  reloadPending: false,
  repos: [],
  active: [],
  recent: [],
  skips: [],
});

const start = (id: string) =>
  RunsCommands.use((runs) =>
    runs.StartRunCommand({
      id: RunId.make(id),
      coreVersion: "0.7.0",
      repo: "demo",
      persona: Option.some("bob"),
      flow: "implement",
      itemKey: `issue-${id}`,
      itemTitle: Option.none(),
      itemUrl: Option.none(),
      item: Option.none(),
    }),
  );

const decodeEvent = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(DaemonEvent)),
);

const decodeStatus = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(DaemonStatus)),
);

// One event of the stream: its name, its id, and its data.
type Frame = { readonly event: string; readonly id: string; readonly data: string };

const field = (lines: ReadonlyArray<string>, name: string) =>
  Option.getOrElse(
    Option.map(Option.fromUndefinedOr(lines.find((line) => line.startsWith(`${name}: `))), (line) =>
      line.slice(name.length + 2),
    ),
    () => "",
  );

// Reads an event stream's bytes, its events (pings left out) into a queue,
// until the reader is interrupted, as a client dropping.
const reader = <E>(bytes: Stream.Stream<Uint8Array, E>) =>
  Effect.gen(function* () {
    const frames = yield* Queue.unbounded<Frame>();
    let lines: Array<string> = [];

    const reading = yield* Effect.forkScoped(
      bytes.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((line) => {
          if (line !== "") {
            lines.push(line);

            return Effect.void;
          }

          const frame = lines;
          lines = [];

          if (frame.every((said) => said.startsWith(":"))) {
            return Effect.void;
          }

          return Queue.offer(frames, {
            event: field(frame, "event"),
            id: field(frame, "id"),
            data: field(frame, "data"),
          });
        }),
        Effect.orDie,
      ),
    );

    // The next event named `event`, past any other.
    const next = (event: string): Effect.Effect<Frame> =>
      Queue.take(frames).pipe(
        Effect.filterOrElse(
          (frame) => frame.event === event,
          () => next(event),
        ),
      );

    return { frames, next, drop: Fiber.interrupt(reading) };
  });

// A client of /events over HTTP.
const connect = (handler: (request: Request) => Promise<Response>) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() => handler(new Request("http://daemon/events")));
    const body = yield* Effect.fromOption(Option.fromNullOr(response.body)).pipe(Effect.orDie);

    const client = yield* reader(
      Stream.fromReadableStream({ evaluate: () => body, onError: (error) => error }),
    );

    return { response, ...client };
  });

// Lets the fibers a client started run until they wait on something: its
// subscription, its checkpoint and its choice of computation take no time.
const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 100 }));

// The /events route over a feed of `snapshot`, as a web handler.
const serving = (snapshot: Effect.Effect<DaemonStatus>) =>
  Effect.gen(function* () {
    const feed = yield* openEventFeed(snapshot);
    const web = HttpRouter.toWebHandler(eventsRoute(feed), { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()));

    return (request: Request) => web.handler(request);
  });

describe("the /events stream", () => {
  effect("sends the snapshot first, then a run started after it", () =>
    Effect.gen(function* () {
      const handler = yield* serving(Effect.succeed(status));
      const client = yield* connect(handler);

      expect(client.response.headers.get("content-type")).toContain("text/event-stream");

      const first = yield* Queue.take(client.frames);
      expect(first.event).toBe("snapshot");
      expect(decodeStatus(first.data).pid).toBe(1);

      yield* start("a");

      const started = yield* client.next("RunStarted");
      expect(started.id).toBe("a:started");
      expect(decodeEvent(started.data)).toMatchObject({
        runId: "a",
        repo: "demo",
        flow: "implement",
      });

      yield* client.drop;
    }).pipe(Effect.provide(daemonInScratch)),
  );

  effect("sends what the daemon says itself", () =>
    Effect.gen(function* () {
      const handler = yield* serving(Effect.succeed(status));
      const client = yield* connect(handler);
      yield* client.next("snapshot");

      yield* broadcastDaemonEvents([
        StatusChanged.make({ eventId: "changed:1", files: ["config.yaml"], at: "now" }),
      ]);

      const changed = yield* client.next("StatusChanged");
      expect(changed.id).toBe("changed:1");
      expect(decodeEvent(changed.data)).toMatchObject({ files: ["config.yaml"] });

      yield* client.drop;
    }).pipe(Effect.provide(daemonInScratch)),
  );

  effect("shares one snapshot between clients that connect at once", () =>
    Effect.gen(function* () {
      const computed = yield* Ref.make(0);
      const gate = yield* Deferred.make<boolean>();

      const handler = yield* serving(
        Ref.update(computed, (count) => count + 1).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.as(status),
        ),
      );

      const clients = yield* Effect.all([connect(handler), connect(handler), connect(handler)], {
        concurrency: "unbounded",
      });

      yield* Deferred.succeed(gate, true);

      for (const client of clients) {
        expect((yield* Queue.take(client.frames)).event).toBe("snapshot");
      }

      expect(yield* Ref.get(computed)).toBe(1);

      for (const client of clients) {
        yield* client.drop;
      }
    }).pipe(Effect.provide(daemonInScratch)),
  );

  effect("tells a client that joins a snapshot begun before it what it missed", () =>
    Effect.gen(function* () {
      const computed = yield* Ref.make(0);
      const begun = yield* Deferred.make<boolean>();
      const gate = yield* Deferred.make<boolean>();

      const handler = yield* serving(
        Ref.update(computed, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(begun, true)),
          Effect.andThen(Deferred.await(gate)),
          Effect.as(status),
        ),
      );

      const early = yield* connect(handler);
      yield* Deferred.await(begun);
      yield* start("a");
      const late = yield* connect(handler);
      yield* Deferred.succeed(gate, true);

      expect((yield* Queue.take(late.frames)).event).toBe("snapshot");
      expect((yield* Queue.take(late.frames)).id).toBe("a:started");
      expect(yield* Ref.get(computed)).toBe(1);

      yield* late.drop;
      yield* early.drop;
    }).pipe(Effect.provide(daemonInScratch)),
  );

  effect("tells a client sharing a snapshot that outlives the sharing window what it missed", () =>
    Effect.gen(function* () {
      const computed = yield* Ref.make(0);
      const begun = yield* Deferred.make<boolean>();
      const gate = yield* Deferred.make<boolean>();

      const feed = yield* openEventFeed(
        Ref.update(computed, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(begun, true)),
          Effect.andThen(Deferred.await(gate)),
          Effect.as(status),
        ),
      );

      // A starts the first computation, which a slow status keeps open.
      const first = yield* reader(feed.connect);
      yield* Deferred.await(begun);

      // B joins it after a run started, which its snapshot may not show.
      yield* start("a");
      const joining = yield* reader(feed.connect);
      yield* settle;

      // Past the sharing window, C starts a second computation, and the bus
      // says something more meanwhile.
      yield* TestClock.adjust(Duration.sum(SNAPSHOT_SHARED_FOR, Duration.millis(200)));
      const latest = yield* reader(feed.connect);

      yield* Effect.yieldNow.pipe(
        Effect.andThen(Ref.get(computed)),
        Effect.repeat({ until: (count) => count >= 2, times: 1000 }),
      );
      yield* start("b");
      yield* Deferred.succeed(gate, true);

      expect((yield* Queue.take(joining.frames)).event).toBe("snapshot");
      expect((yield* Queue.take(joining.frames)).id).toBe("a:started");
      expect((yield* joining.next("RunStarted")).id).toBe("b:started");
      expect(yield* Ref.get(computed)).toBe(2);

      yield* Effect.forEach([first, joining, latest], (client) => client.drop);
      // The test's clock is virtual; the engine, built beside it, keeps the real one.
    }).pipe(Effect.provide(Layer.mergeAll(daemonInScratch, TestClock.layer()))),
  );

  effect("starts a fresh snapshot for a client that connects after one failed", () =>
    Effect.gen(function* () {
      const computed = yield* Ref.make(0);

      const feed = yield* openEventFeed(
        Ref.updateAndGet(computed, (count) => count + 1).pipe(
          Effect.filterOrFail(
            (count) => count > 1,
            () => "status failed",
          ),
          Effect.as(status),
        ),
      );

      // The first client's stream ends with nothing, its snapshot failed.
      const failed = yield* Stream.runCollect(feed.connect.pipe(Stream.take(1)));
      expect(failed).toEqual([]);

      const again = yield* reader(feed.connect);
      expect((yield* Queue.take(again.frames)).event).toBe("snapshot");
      expect(yield* Ref.get(computed)).toBe(2);

      yield* again.drop;
    }).pipe(Effect.provide(daemonInScratch)),
  );

  effect("releases a dropped client's subscription", () =>
    Effect.gen(function* () {
      const open = yield* OpenStreams;
      const handler = yield* serving(Effect.succeed(status));
      // The feed's own subscription, which lasts as long as the daemon.
      const feedOnly = open.count;

      const client = yield* connect(handler);
      yield* client.next("snapshot");
      expect(open.count).toBe(feedOnly + 1);

      yield* client.drop;

      const left = yield* Effect.sync(() => open.count).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 millis"),
          until: (count) => count === feedOnly,
          times: 200,
        }),
      );

      expect(left).toBe(feedOnly);
    }).pipe(Effect.provide(daemonInScratch)),
  );
});
