// The CLI and TUI talk to the daemon over a local socket and never open the
// workflow engine themselves.

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { Home, homePaths } from "../../platform/home.ts";
import {
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
