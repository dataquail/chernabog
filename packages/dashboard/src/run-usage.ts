// What a run spent, as its page loads it from GET /api/runs/:id/usage: its
// tokens by model and by step, and its compute time. Which of the daemon's
// events mean the page should load it again, and how its numbers read.

import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";

import type { RunUsage } from "#daemon/protocol";

import type { Heard } from "./feed.ts";

// `unavailable` when the daemon wouldn't say: one from before the route, or
// one that refused.
export type UsageState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "loaded"; readonly usage: RunUsage };

export const loadUsage = (
  _origin: string,
  _runId: string,
): Effect.Effect<UsageState, never, HttpClient.HttpClient> =>
  Effect.succeed({ kind: "unavailable" });

export const refetchesUsageFor = (_heard: Heard, _runId: string): boolean => false;

export const compactTokens = (count: number): string => String(count);
