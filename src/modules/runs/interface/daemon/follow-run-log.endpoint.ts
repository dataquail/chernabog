// GET /runs/:id/log: a run's log as an event stream. Until #328 lands, nothing.

import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const followRunLogEndpoint = Effect.succeed(HttpServerResponse.empty({ status: 501 }));
