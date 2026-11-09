// What a run spent, as its page loads it from GET /api/runs/:id/usage: its
// tokens by model and by step, and its compute time. Which of the daemon's
// events mean the page should load it again, and how its numbers read.

import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { RunUsage } from "#daemon/protocol";

import type { Heard } from "./feed.ts";

// `unavailable` when the daemon wouldn't say: one from before the route, or
// one that refused.
export type UsageState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "loaded"; readonly usage: RunUsage };

const unavailable: UsageState = { kind: "unavailable" };

// `origin` is where the page came from (`location.origin` in a browser);
// `runId` the run's whole id.
export const loadUsage = (
  origin: string,
  runId: string,
): Effect.Effect<UsageState, never, HttpClient.HttpClient> =>
  HttpClient.get(new URL(`/api/runs/${encodeURIComponent(runId)}/usage`, origin)).pipe(
    Effect.filterOrFail((response) => response.status >= 200 && response.status < 300),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(RunUsage)),
    Effect.map((usage): UsageState => ({ kind: "loaded", usage })),
    Effect.orElseSucceed(() => unavailable),
  );

// The events about a run that change what it spent or its compute time: an
// agent call ending, and a step starting or ending, or the run finishing.
const RELOADS_ON: ReadonlySet<string> = new Set([
  "TokenUsageRecorded",
  "RunEnteredStep",
  "RunFinishedStep",
  "RunFinished",
]);

export const refetchesUsageFor = (heard: Heard, runId: string): boolean =>
  heard.kind === "event" &&
  RELOADS_ON.has(heard.event._tag) &&
  "runId" in heard.event &&
  heard.event.runId === runId;

const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

// A count of tokens as people read one at a glance: 950, 56.7K, 1.2M.
export const compactTokens = (count: number): string => COMPACT.format(count);

const EXACT = new Intl.NumberFormat("en-US");

// The count in full, for a tooltip.
export const exactTokens = (count: number): string => EXACT.format(count);
