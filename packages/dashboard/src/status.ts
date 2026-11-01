// The daemon's status, as the daemon that served this page answers /api/status,
// decoded with the daemon's own protocol.

import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";

import { DaemonStatus } from "#daemon/protocol";

export class StatusUnavailable extends Schema.TaggedError<
  StatusUnavailable,
  { readonly brand: "StatusUnavailable" }
>()("StatusUnavailable", {
  message: Schema.String,
}) {}

// `origin` is where the page came from (`location.origin` in a browser).
export const loadStatus = (origin: string) =>
  HttpClient.get(new URL("/api/status", origin)).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(DaemonStatus)),
    Effect.mapError((error) => new StatusUnavailable({ message: error.message })),
  );
