// The TUI's client of GET /events, over the daemon's socket: the snapshot,
// then each event it knows, until the daemon ends the stream.

import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { daemonEvents } from "../src/interface/daemon/daemon.client.ts";
import {
  DaemonEvent,
  DaemonStatus,
  StatusChanged,
} from "../src/interface/daemon/daemon.protocol.ts";
import { Home, homePaths } from "../src/platform/home.ts";
import { effectAtHomeWith } from "./effect-test.ts";

const effectAtHome = effectAtHomeWith(FetchHttpClient.layer);

const encodeStatus = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(DaemonStatus)));
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(DaemonEvent)));

const status: DaemonStatus = {
  pid: 4242,
  startedAt: "2026-10-31T12:00:00.000Z",
  busy: 0,
  reloadPending: false,
  repos: [],
  active: [],
  recent: [],
  skips: [],
};

const changed = StatusChanged.make({
  eventId: "e1",
  files: ["config.yaml"],
  at: "2026-10-31T12:00:01.000Z",
});

// A daemon on the home's socket that answers /events with `body`, then ends it.
const serving = (body: string) =>
  Effect.gen(function* () {
    const { socket } = homePaths((yield* Home).root);

    yield* Layer.build(
      HttpRouter.serve(
        HttpRouter.add(
          "GET",
          "/events",
          Effect.succeed(
            HttpServerResponse.stream(Stream.encodeText(Stream.make(body)), {
              contentType: "text/event-stream",
            }),
          ),
        ),
        { disableLogger: true, disableListenLog: true },
      ).pipe(Layer.provide(BunHttpServer.layer({ unix: socket }))),
    );
  });

describe("daemonEvents", () => {
  effectAtHome("reads the snapshot, then the events it knows, pings and newer ones left out", () =>
    Effect.gen(function* () {
      yield* serving(
        [
          `event: snapshot\ndata: ${encodeStatus(status)}\n\n`,
          ": ping\n\n",
          `event: StatusChanged\nid: e1\ndata: ${encodeEvent(changed)}\n\n`,
          'event: SomethingNewer\nid: e2\ndata: {"_tag":"SomethingNewer"}\n\n',
        ].join(""),
      );

      const heard = yield* Stream.runCollect(daemonEvents);

      expect(heard).toEqual([
        { kind: "snapshot", status },
        { kind: "event", event: changed },
      ]);
    }),
  );

  effectAtHome("fails when no daemon is running", () =>
    Effect.gen(function* () {
      const ended = yield* Effect.flip(Stream.runCollect(daemonEvents));

      expect(ended._tag).toBe("DaemonUnavailable");
    }),
  );
});
