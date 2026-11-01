// What GET /api/events says to the page: the daemon's status once, then each
// event, decoded with the daemon's protocol.

import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { type DaemonEvent, type DaemonStatus } from "#daemon/protocol";

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

export const daemonFeed = (
  _origin: string,
): Stream.Stream<Heard, FeedFailed, HttpClient.HttpClient> =>
  Stream.unwrap(Effect.map(HttpClient.HttpClient, () => Stream.empty));
