// A run's log, as the page follows it. A stub until #328.

import type * as HttpClient from "effect/http/HttpClient";
import * as Stream from "effect/Stream";

import type { FeedFailed } from "./feed.ts";

export const MAX_LOG_LINES = 10_000;

export type LogHeard =
  | { readonly kind: "connected" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "end" };

export type LogConnection =
  | { readonly kind: "connecting" }
  | { readonly kind: "live" }
  | { readonly kind: "reconnecting" }
  | { readonly kind: "ended" };

export type LogState = {
  readonly lines: ReadonlyArray<string>;
  readonly connection: LogConnection;
};

export const initialLog: LogState = { lines: [], connection: { kind: "connecting" } };

export const appended = (lines: ReadonlyArray<string>, _text: string): ReadonlyArray<string> =>
  lines;

export const hearLog = (log: LogState, _heard: LogHeard): LogState => log;

export const runLogFeed = (
  _origin: string,
  _runId: string,
): Stream.Stream<LogHeard, FeedFailed, HttpClient.HttpClient> => Stream.empty;
