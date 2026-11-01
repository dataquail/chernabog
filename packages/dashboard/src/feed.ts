// What GET /api/events says to the page: the daemon's status once, then each
// event, decoded with the daemon's protocol. It fails as `unreachable` when
// nothing listens (the dashboard was stopped, or the daemon is restarting),
// `refused` when the daemon answers with an error, and `dropped` when the
// stream breaks or ends.

import * as Effect from "effect/Effect";
import * as Sse from "effect/encoding/Sse";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { DaemonEvent, DaemonStatus, Refusal } from "#daemon/protocol";

export type Heard =
  | { readonly kind: "snapshot"; readonly status: DaemonStatus }
  | { readonly kind: "event"; readonly event: DaemonEvent };

export class FeedFailed extends Schema.TaggedError<FeedFailed, { readonly brand: "FeedFailed" }>()(
  "FeedFailed",
  {
    reason: Schema.Literals(["unreachable", "refused", "dropped"]),
    message: Schema.String,
  },
) {}

const decodeStatusJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(DaemonStatus)),
);

const decodeEventJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(DaemonEvent)),
);

// One event of the stream: an event this page doesn't know, from a newer
// daemon, is left out.
const heardOf = (frame: Sse.Event): Option.Option<Heard> => {
  if (frame.event === "snapshot") {
    return Option.map(decodeStatusJson(frame.data), (status) => ({ kind: "snapshot", status }));
  }

  return Option.map(decodeEventJson(frame.data), (event) => ({ kind: "event", event }));
};

const unreachable = (error: HttpClientError.HttpClientError) =>
  new FeedFailed({ reason: "unreachable", message: error.message });

// The daemon's own reason, from its Refusal, else the status it answered.
const refused = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(Refusal)(response).pipe(
    Effect.match({
      onFailure: () => `the daemon answered ${response.status}`,
      onSuccess: (refusal) => refusal.error,
    }),
    Effect.flatMap((message) => Effect.fail(new FeedFailed({ reason: "refused", message }))),
  );

const connect = (origin: string) =>
  HttpClient.get(new URL("/api/events", origin)).pipe(
    Effect.mapError(unreachable),
    Effect.filterOrElse((response) => response.status >= 200 && response.status < 300, refused),
  );

// `origin` is where the page came from (`location.origin` in a browser).
export const daemonFeed = (
  origin: string,
): Stream.Stream<Heard, FeedFailed, HttpClient.HttpClient> =>
  Stream.unwrap(
    Effect.map(connect(origin), (response) =>
      response.stream.pipe(
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.mapError(
          () => new FeedFailed({ reason: "dropped", message: "the daemon's event stream dropped" }),
        ),
        Stream.filterMap((frame) => Result.fromOption(heardOf(frame), () => frame)),
      ),
    ),
  );
