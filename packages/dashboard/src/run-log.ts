// A run's log, as its page follows GET /api/runs/:id/log: each connection
// sends the log from its start, then what it gains, then `end` once the run
// has finished. The page keeps the last MAX_LOG_LINES lines, starts over on
// each connection, and connects again when a stream drops before its end.

import * as Effect from "effect/Effect";
import * as Sse from "effect/encoding/Sse";
import * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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

// A plan node, in its round and lane, as a run's history names it.
export type LogNode = { readonly id: string; readonly round?: number; readonly lane?: string };

const NodeJson = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    round: Schema.optionalKey(Schema.Int),
    lane: Schema.optionalKey(Schema.String),
  }),
);

// Where a run's log is, or one step's of it, or one step's at one plan node.
export const logUrl = (
  origin: string,
  runId: string,
  step: Option.Option<string>,
  node: Option.Option<LogNode> = Option.none(),
) => {
  const url = new URL(`/api/runs/${encodeURIComponent(runId)}/log`, origin);

  for (const name of Option.toArray(step)) {
    url.searchParams.set("step", name);

    for (const at of Option.toArray(node)) {
      url.searchParams.set(
        "node",
        Schema.encodeSync(NodeJson)({
          id: at.id,
          ...Option.match(Option.fromUndefinedOr(at.round), {
            onNone: () => ({}),
            onSome: (round) => ({ round }),
          }),
          ...Option.match(Option.fromUndefinedOr(at.lane), {
            onNone: () => ({}),
            onSome: (lane) => ({ lane }),
          }),
        }),
      );
    }
  }

  return url;
};

// `origin` is where the page came from (`location.origin` in a browser);
// `step`, the step whose lines alone it follows, for a daemon that keeps
// them, and `node`, the plan node whose lines of that step alone it follows.
export const runLogFeed = (
  origin: string,
  runId: string,
  step: Option.Option<string> = Option.none(),
  node: Option.Option<LogNode> = Option.none(),
): Stream.Stream<LogHeard, FeedFailed, HttpClient.HttpClient> =>
  Stream.unwrap(
    HttpClient.get(logUrl(origin, runId, step, node)).pipe(
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

// A line the run's log starts a step with, its time before it or not.
const STEP_LINE = /^(?:\S+ )?step: (.+)$/;

// The lines of one step of a run on one line, from the whole log: from the
// line that starts it to the line that starts the next. For a log the daemon
// kept no step of each line in, which only a run with no lanes can be split by.
export const linesOfStep = (lines: ReadonlyArray<string>, step: string): ReadonlyArray<string> => {
  let current = Option.none<string>();

  return lines.filter((line) => {
    for (const started of Option.toArray(Option.fromNullishOr(STEP_LINE.exec(line)?.[1]))) {
      current = Option.some(started);
    }

    return Option.contains(current, step);
  });
};
