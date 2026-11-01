// A run's log, as its page follows GET /api/runs/:id/log: each connection
// sends the log from its start, then what it gains, then `end` once the run
// has finished. The page keeps the last MAX_LOG_LINES lines, starts over on
// each connection, and connects again when a stream drops before its end.

import * as Effect from "effect/Effect";
import * as Sse from "effect/encoding/Sse";
import * as HttpClient from "effect/http/HttpClient";
import * as Stream from "effect/Stream";

import { FeedFailed } from "./feed.ts";

// The most lines of a log the page holds: the last ones.
export const MAX_LOG_LINES = 10_000;

// What a connection says, and that one dropped before its end.
export type LogHeard =
  | { readonly kind: "connected" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "end" }
  | { readonly kind: "dropped" };

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

// `lines` with `text`'s lines after them, the last MAX_LOG_LINES of them.
export const appended = (lines: ReadonlyArray<string>, text: string): ReadonlyArray<string> =>
  [...lines, ...text.split("\n")].slice(-MAX_LOG_LINES);

export const hearLog = (log: LogState, heard: LogHeard): LogState => {
  switch (heard.kind) {
    case "connected":
      return { lines: [], connection: { kind: "live" } };
    case "text":
      return { ...log, lines: appended(log.lines, heard.text) };
    case "end":
      return { ...log, connection: { kind: "ended" } };
    case "dropped":
      return { ...log, connection: { kind: "reconnecting" } };
  }
};

// How close to its bottom, in pixels, the log counts as followed.
const AT_BOTTOM_WITHIN = 8;

// Whether the log is scrolled to its bottom, so the page keeps it there as it
// grows; a person who scrolls up stops that until they scroll back down.
export const atBottom = (box: {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}) => box.scrollHeight - box.scrollTop - box.clientHeight <= AT_BOTTOM_WITHIN;

const heardOf = (frame: Sse.Event): LogHeard => {
  if (frame.event === "end") {
    return { kind: "end" };
  }

  return { kind: "text", text: frame.data };
};

const failed = (reason: FeedFailed["reason"], message: string) =>
  new FeedFailed({ reason, message });

// `origin` is where the page came from (`location.origin` in a browser).
export const runLogFeed = (
  origin: string,
  runId: string,
): Stream.Stream<LogHeard, FeedFailed, HttpClient.HttpClient> =>
  Stream.unwrap(
    HttpClient.get(new URL(`/api/runs/${encodeURIComponent(runId)}/log`, origin)).pipe(
      Effect.mapError((error) => failed("unreachable", error.message)),
      Effect.filterOrFail(
        (response) => response.status >= 200 && response.status < 300,
        (response) => failed("refused", `the daemon answered ${response.status}`),
      ),
      Effect.map((response) =>
        Stream.succeed<LogHeard>({ kind: "connected" }).pipe(
          Stream.concat(
            response.stream.pipe(
              Stream.decodeText,
              Stream.pipeThroughChannel(Sse.decode()),
              Stream.mapError(() => failed("dropped", "the run's log stream dropped")),
              Stream.map(heardOf),
            ),
          ),
        ),
      ),
    ),
  );
