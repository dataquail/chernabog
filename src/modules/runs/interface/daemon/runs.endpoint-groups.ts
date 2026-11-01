// The runs module's routes on the daemon's socket, which the daemon's server
// registers beside its own (docs/adr/0014-inbound-adapters-live-in-their-module.md).
// How a failure answers is the server's, so it hands its `answer` in.

import type * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

import { findRunEndpoint } from "./find-run.endpoint.ts";
import { followRunLogEndpoint } from "./follow-run-log.endpoint.ts";
import { readRunHistoryEndpoint } from "./read-run-history.endpoint.ts";

// What the server makes of a route's handler: its failures answered as refusals,
// leaving only what answering one can fail with.
export type Answer<X> = <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => Effect.Effect<HttpServerResponse.HttpServerResponse, X, R>;

export const runsRoutes = <X>(answer: Answer<X>) =>
  Layer.mergeAll(
    HttpRouter.add("GET", "/runs/:id", answer(findRunEndpoint)),
    HttpRouter.add("GET", "/runs/:id/history", answer(readRunHistoryEndpoint)),
    HttpRouter.add("GET", "/runs/:id/log", answer(followRunLogEndpoint)),
  );
