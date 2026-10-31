// The CLI and TUI talk to the daemon over a local socket and never open the
// workflow engine themselves.

import * as Effect from "effect/Effect";
import * as Sse from "effect/encoding/Sse";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { CancelledRun, RunHistory } from "../../modules/runs/runs.platform.ts";
import { Home, homePaths } from "../../platform/home.ts";
import {
  CancelRequest,
  DaemonEvent,
  DaemonStatus,
  Refusal,
  Reloaded,
  RunReply,
  RunRequest,
  TickResult,
} from "./daemon.protocol.ts";

export class DaemonUnavailable extends Schema.TaggedError<
  DaemonUnavailable,
  { readonly brand: "DaemonUnavailable" }
>()("DaemonUnavailable", {
  message: Schema.String,
}) {}

export class DaemonRefused extends Schema.TaggedError<
  DaemonRefused,
  { readonly brand: "DaemonRefused" }
>()("DaemonRefused", {
  message: Schema.String,
}) {}

const send = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const socket = homePaths((yield* Home).root).socket;

    if (!(yield* fs.exists(socket).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new DaemonUnavailable({
        message:
          "the daemon is not running (start it with chernabog start, or chernabog install the first time)",
      });
    }

    const client = yield* HttpClient.HttpClient;
    // Bun's fetch reaches a unix socket through its own `unix` option.
    const overSocket: BunFetchRequestInit = { unix: socket };

    const response = yield* client
      .execute(HttpClientRequest.prependUrl(request, "http://chernabog"))
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, overSocket),
        Effect.mapError(
          () => new DaemonUnavailable({ message: `the daemon is not answering on ${socket}` }),
        ),
      );

    if (response.status < 400) {
      return response;
    }

    const refusal = yield* HttpClientResponse.schemaBodyJson(Refusal)(response).pipe(Effect.option);

    return yield* new DaemonRefused({
      message: Option.match(refusal, {
        onNone: () => `HTTP ${response.status}`,
        onSome: (said) => said.error,
      }),
    });
  });

const reply =
  <S extends Schema.Constraint>(schema: S) =>
  (response: HttpClientResponse.HttpClientResponse) =>
    HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(
        (error) =>
          new DaemonRefused({
            message: `unexpected reply from the daemon: ${error.message}`,
          }),
      ),
    );

const withRequest = (request: HttpClientRequest.HttpClientRequest, body: RunRequest) =>
  HttpClientRequest.schemaBodyJson(RunRequest)(request, body).pipe(
    Effect.mapError((error) => new DaemonRefused({ message: error.message })),
  );

export const daemonStatus = send(HttpClientRequest.get("/status")).pipe(
  Effect.flatMap(reply(DaemonStatus)),
);

export const daemonRun = (request: RunRequest) =>
  withRequest(HttpClientRequest.post("/run"), request).pipe(
    Effect.flatMap(send),
    Effect.flatMap(reply(TickResult)),
  );

export const daemonTick = (request: RunRequest) =>
  withRequest(HttpClientRequest.post("/tick"), request).pipe(
    Effect.flatMap(send),
    Effect.flatMap(reply(TickResult)),
  );

export const daemonReload = send(HttpClientRequest.post("/reload")).pipe(
  Effect.flatMap(reply(Reloaded)),
);

export const daemonRunRow = (runId: string) =>
  send(HttpClientRequest.get(`/runs/${encodeURIComponent(runId)}`)).pipe(
    Effect.flatMap(reply(RunReply)),
  );

// The steps a run has entered and the signals it waits on.
export const daemonRunHistory = (runId: string) =>
  send(HttpClientRequest.get(`/runs/${encodeURIComponent(runId)}/history`)).pipe(
    Effect.flatMap(reply(RunHistory)),
  );

export const daemonCancel = (request: CancelRequest) =>
  HttpClientRequest.schemaBodyJson(CancelRequest)(HttpClientRequest.post("/cancel"), request).pipe(
    Effect.mapError((error) => new DaemonRefused({ message: error.message })),
    Effect.flatMap(send),
    Effect.flatMap(reply(CancelledRun)),
  );

// What GET /events says: what /status answers, once, then each event.
export type DaemonFeed =
  | { readonly kind: "snapshot"; readonly status: DaemonStatus }
  | { readonly kind: "event"; readonly event: DaemonEvent };

const decodeStatusJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(DaemonStatus)),
);

const decodeEventJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(DaemonEvent)),
);

// One event of the stream, as the feed: an event this chernabog doesn't know,
// from a newer daemon, is left out.
const feedOf = (frame: Sse.Event): Option.Option<DaemonFeed> => {
  if (frame.event === "snapshot") {
    return Option.map(decodeStatusJson(frame.data), (status) => ({ kind: "snapshot", status }));
  }

  return Option.map(decodeEventJson(frame.data), (event) => ({ kind: "event", event }));
};

// GET /events, for as long as the daemon keeps it open. It ends, or fails,
// when the daemon goes; the caller connects again.
export const daemonEvents = Stream.unwrap(
  Effect.map(send(HttpClientRequest.get("/events")), (response) =>
    response.stream.pipe(
      Stream.decodeText,
      Stream.pipeThroughChannel(Sse.decode()),
      Stream.mapError(
        () => new DaemonUnavailable({ message: "the daemon's event stream dropped" }),
      ),
      Stream.filterMap((frame) => Result.fromOption(feedOf(frame), () => frame)),
    ),
  ),
);
