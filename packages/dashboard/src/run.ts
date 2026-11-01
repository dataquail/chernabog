// A run's detail, as the page loads it. A stub until #328.

import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";

import type { DaemonStatus, RunHistory } from "#daemon/protocol";

import type { Heard } from "./feed.ts";

type RunView = DaemonStatus["recent"][number];

export type Detail =
  | { readonly kind: "loading" }
  | { readonly kind: "unknown" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "found"; readonly run: RunView; readonly history: RunHistory };

export const loadDetail = (
  _origin: string,
  _asked: string,
): Effect.Effect<Detail, never, HttpClient.HttpClient> => Effect.succeed({ kind: "loading" });

export const refetchesFor = (_heard: Heard, _runId: string): boolean => false;
