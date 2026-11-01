// One run, as its page loads it: its row from GET /api/runs/:id, by what the
// page was asked (a unique prefix of the id will do), then its history from
// GET /api/runs/:id/history, by its whole id. And which of the daemon's events
// mean the page should load it again.

import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type DaemonStatus, Refusal, RunHistory, RunReply } from "#daemon/protocol";

import type { Heard } from "./feed.ts";

type RunView = DaemonStatus["recent"][number];

export type Detail =
  | { readonly kind: "loading" }
  | { readonly kind: "unknown" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "found"; readonly run: RunView; readonly history: RunHistory };

// The daemon's own reason, from its Refusal, else the status it answered.
const reason = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(Refusal)(response).pipe(
    Effect.match({
      onFailure: () => `the daemon answered ${response.status}`,
      onSuccess: (refusal) => refusal.error,
    }),
  );

class Refused extends Schema.TaggedError<Refused, { readonly brand: "Refused" }>()("Refused", {
  message: Schema.String,
}) {}

const ask = (origin: string, path: string) =>
  HttpClient.get(new URL(`/api/runs/${path}`, origin)).pipe(
    Effect.mapError((error) => new Refused({ message: error.message })),
    Effect.filterOrElse(
      (response) => response.status >= 200 && response.status < 300,
      (response) =>
        Effect.flatMap(reason(response), (message) => Effect.fail(new Refused({ message }))),
    ),
  );

const decoded =
  <A>(
    read: (
      response: HttpClientResponse.HttpClientResponse,
    ) => Effect.Effect<A, { readonly message: string }>,
  ) =>
  (response: HttpClientResponse.HttpClientResponse) =>
    read(response).pipe(Effect.mapError((error) => new Refused({ message: error.message })));

// `origin` is where the page came from (`location.origin` in a browser).
export const loadDetail = (
  origin: string,
  asked: string,
): Effect.Effect<Detail, never, HttpClient.HttpClient> =>
  ask(origin, encodeURIComponent(asked)).pipe(
    Effect.flatMap(decoded(HttpClientResponse.schemaBodyJson(RunReply))),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed<Detail>({ kind: "unknown" }),
        onSome: (run) =>
          ask(origin, `${encodeURIComponent(run.id)}/history`).pipe(
            Effect.flatMap(decoded(HttpClientResponse.schemaBodyJson(RunHistory))),
            Effect.map((history): Detail => ({ kind: "found", run, history })),
          ),
      }),
    ),
    Effect.catch((refused) =>
      Effect.succeed<Detail>({ kind: "refused", message: refused.message }),
    ),
  );

// The events about a run that change its row or its history.
const RELOADS_ON: ReadonlySet<string> = new Set([
  "RunEnteredStep",
  "RunNeedsAttention",
  "RunFinished",
]);

// Whether what the daemon said means the run `runId` should be loaded again:
// it entered a step, parked or finished.
export const refetchesFor = (heard: Heard, runId: string): boolean =>
  heard.kind === "event" &&
  RELOADS_ON.has(heard.event._tag) &&
  "runId" in heard.event &&
  heard.event.runId === runId;
