// How the dashboard follows the daemon: what GET /api/events says, and what
// the page holds from it.

import { describe, expect, test } from "bun:test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { it } from "effect-bun-test";

import { DaemonEvent, DaemonStatus, StatusChanged } from "#daemon/protocol";

import { daemonFeed, FeedFailed } from "./feed.ts";
import {
  hear,
  initial,
  type Live,
  type Message,
  reconnectDelay,
  REFETCH_AT_MOST_EVERY,
  STOPPED_AFTER,
} from "./live.ts";

const encodeStatus = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(DaemonStatus)));
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(DaemonEvent)));

const status = (pid: number): DaemonStatus => ({
  pid,
  startedAt: "2026-10-31T12:00:00.000Z",
  busy: 0,
  reloadPending: false,
  repos: [],
  active: [],
  recent: [],
  skips: [],
});

const changed = StatusChanged.make({
  eventId: "e1",
  files: ["config.yaml"],
  at: "2026-10-31T12:00:01.000Z",
});

// A daemon that answers every request with what `reply` makes, and the URLs
// it was asked for.
const daemonAnswering = (reply: () => Response) => {
  const asked: Array<string> = [];

  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      asked.push(url.href);

      return HttpClientResponse.fromWeb(request, reply());
    }),
  );

  return { asked, client };
};

// A listener that isn't there: every request fails to connect.
const nobodyListening = HttpClient.make((request) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, description: "connection refused" }),
    }),
  ),
);

// The live state after each message in turn.
const after = (messages: ReadonlyArray<Message>, from: Live = initial) =>
  messages.reduce((live, message) => hear(live, message).live, from);

describe("the dashboard's feed of /api/events", () => {
  it.live("reads the snapshot, then the events it knows, leaving out pings and newer ones", () =>
    Effect.gen(function* () {
      const { asked, client } = daemonAnswering(
        () =>
          new Response(
            [
              `event: snapshot\ndata: ${encodeStatus(status(4242))}\n\n`,
              ": ping\n\n",
              `event: StatusChanged\nid: e1\ndata: ${encodeEvent(changed)}\n\n`,
              'event: SomethingNewer\nid: e2\ndata: {"_tag":"SomethingNewer"}\n\n',
            ].join(""),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );

      const heard = yield* Stream.runCollect(daemonFeed("http://daemon")).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      expect(asked).toEqual(["http://daemon/api/events"]);
      expect(heard).toEqual([
        { kind: "snapshot", status: status(4242) },
        { kind: "event", event: changed },
      ]);
    }),
  );

  it.live("fails as unreachable when nothing listens", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(
        Stream.runCollect(daemonFeed("http://daemon")).pipe(
          Effect.provideService(HttpClient.HttpClient, nobodyListening),
        ),
      );

      expect(failed).toBeInstanceOf(FeedFailed);
      expect(failed.reason).toBe("unreachable");
    }),
  );

  it.live("fails as refused, with the daemon's reason, when it answers with an error", () =>
    Effect.gen(function* () {
      const { client } = daemonAnswering(() =>
        Response.json(
          { error: "open the dashboard from the URL chernabog ui prints" },
          { status: 401 },
        ),
      );

      const failed = yield* Effect.flip(
        Stream.runCollect(daemonFeed("http://daemon")).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        ),
      );

      expect(failed.reason).toBe("refused");
      expect(failed.message).toBe("open the dashboard from the URL chernabog ui prints");
    }),
  );
});

describe("what the dashboard holds from the feed", () => {
  test("connects first, then shows the snapshot", () => {
    expect(initial.connection.kind).toBe("connecting");
    expect(Option.isNone(initial.status)).toBe(true);

    const live = after([{ kind: "snapshot", status: status(1) }]);

    expect(live.connection.kind).toBe("live");
    expect(Option.map(live.status, (shown) => shown.pid)).toEqual(Option.some(1));
  });

  test("asks /status again once for a burst of events, and shows what it answered", () => {
    const shown = after([{ kind: "snapshot", status: status(1) }]);

    const first = hear(shown, { kind: "event", event: changed });

    expect(first.refetchIn).toEqual(Option.some(REFETCH_AT_MOST_EVERY));

    const second = hear(first.live, { kind: "event", event: changed });

    expect(Option.isNone(second.refetchIn)).toBe(true);

    const answered = hear(second.live, { kind: "refetched", status: Option.some(status(2)) });

    expect(Option.map(answered.live.status, (now) => now.pid)).toEqual(Option.some(2));
    expect(hear(answered.live, { kind: "event", event: changed }).refetchIn).toEqual(
      Option.some(REFETCH_AT_MOST_EVERY),
    );
  });

  test("keeps what it showed when a refetch fails", () => {
    const live = after([
      { kind: "snapshot", status: status(1) },
      { kind: "event", event: changed },
      { kind: "refetched", status: Option.none() },
    ]);

    expect(Option.map(live.status, (shown) => shown.pid)).toEqual(Option.some(1));
    expect(live.refetching).toBe(false);
  });

  test("says reconnecting when the stream drops, keeping what it showed", () => {
    const live = after([
      { kind: "snapshot", status: status(1) },
      {
        kind: "failed",
        failure: new FeedFailed({ reason: "dropped", message: "the event stream dropped" }),
      },
    ]);

    expect(live.connection).toEqual({ kind: "reconnecting", reason: "the event stream dropped" });
    expect(Option.isSome(live.status)).toBe(true);
  });

  test("says the dashboard was stopped once its listener stays gone, and recovers when it's back", () => {
    const unreachable: Message = {
      kind: "failed",
      failure: new FeedFailed({ reason: "unreachable", message: "connection refused" }),
    };

    const shown = after([{ kind: "snapshot", status: status(1) }]);

    const almost = after(
      Array.from({ length: STOPPED_AFTER - 1 }, () => unreachable),
      shown,
    );

    expect(almost.connection.kind).toBe("reconnecting");

    const stopped = after([unreachable], almost);

    expect(stopped.connection.kind).toBe("stopped");

    const back = after([{ kind: "snapshot", status: status(2) }], stopped);

    expect(back.connection.kind).toBe("live");
    expect(after([unreachable], back).connection.kind).toBe("reconnecting");
  });

  test("says why the daemon refused it", () => {
    const live = after([
      {
        kind: "failed",
        failure: new FeedFailed({ reason: "refused", message: "open it from chernabog ui" }),
      },
    ]);

    expect(live.connection).toEqual({ kind: "refused", message: "open it from chernabog ui" });
  });

  test("backs off 1, 2, 4, then every 5 seconds", () => {
    expect([0, 1, 2, 3, 9].map((attempt) => Duration.toMillis(reconnectDelay(attempt)))).toEqual([
      1000, 2000, 4000, 5000, 5000,
    ]);
  });
});
