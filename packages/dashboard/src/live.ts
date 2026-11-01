// What the page holds from the daemon as it follows GET /api/events, as the
// TUI's live view does (src/interface/tui/live.ts): the stream's snapshot
// replaces the status, each event after it asks /api/status again, once for a
// burst, and a dropped stream keeps what the page showed and says it is
// reconnecting. Pure, so the hook (use-daemon.ts) only carries it out.

import * as Duration from "effect/Duration";
import * as Option from "effect/Option";

import type { DaemonStatus } from "#daemon/protocol";

import type { FeedFailed, Heard } from "./feed.ts";

// The most often the page asks /api/status again for what events said.
export const REFETCH_AT_MOST_EVERY = Duration.millis(250);

// How many connections in a row must find no listener before the page says
// the dashboard was stopped, rather than that the daemon is restarting:
// 1 + 2 + 4 seconds of backoff.
export const STOPPED_AFTER = 3;

export type Connection =
  | { readonly kind: "connecting" }
  | { readonly kind: "live" }
  | { readonly kind: "reconnecting"; readonly reason: string }
  | { readonly kind: "stopped" }
  | { readonly kind: "refused"; readonly message: string };

export type Live = {
  readonly status: Option.Option<DaemonStatus>;
  readonly connection: Connection;
  // Whether a refetch is already on its way.
  readonly refetching: boolean;
  // Connections in a row that found no listener.
  readonly unreachable: number;
};

// What the page hears: the stream's snapshot or an event, what a refetch
// answered (none when it failed), or why the stream failed.
export type Message =
  | Heard
  | { readonly kind: "refetched"; readonly status: Option.Option<DaemonStatus> }
  | { readonly kind: "failed"; readonly failure: FeedFailed };

export type Followed = {
  readonly live: Live;
  // How long from now to ask /api/status again, when this asks it.
  readonly refetchIn: Option.Option<Duration.Duration>;
};

export const initial: Live = {
  status: Option.none(),
  connection: { kind: "connecting" },
  refetching: false,
  unreachable: 0,
};

const unchanged = (live: Live): Followed => ({ live, refetchIn: Option.none() });

const failed = (live: Live, failure: FeedFailed): Live => {
  switch (failure.reason) {
    case "refused":
      return { ...live, connection: { kind: "refused", message: failure.message }, unreachable: 0 };
    case "dropped":
      return {
        ...live,
        connection: { kind: "reconnecting", reason: failure.message },
        unreachable: 0,
      };
    case "unreachable": {
      const unreachable = live.unreachable + 1;

      if (unreachable >= STOPPED_AFTER) {
        return { ...live, unreachable, connection: { kind: "stopped" } };
      }

      return {
        ...live,
        unreachable,
        connection: { kind: "reconnecting", reason: failure.message },
      };
    }
  }
};

export const hear = (live: Live, message: Message): Followed => {
  switch (message.kind) {
    case "snapshot":
      return unchanged({
        ...live,
        status: Option.some(message.status),
        connection: { kind: "live" },
        unreachable: 0,
      });
    case "event":
      if (live.refetching) {
        return unchanged(live);
      }

      return { live: { ...live, refetching: true }, refetchIn: Option.some(REFETCH_AT_MOST_EVERY) };
    case "refetched":
      return unchanged({
        ...live,
        refetching: false,
        status: Option.orElse(message.status, () => live.status),
      });
    case "failed":
      return unchanged(failed(live, message.failure));
  }
};

const BACKOFF = [Duration.seconds(1), Duration.seconds(2), Duration.seconds(4)];

// How long to wait before the attempt'th reconnect in a row, from 0.
export const reconnectDelay = (attempt: number): Duration.Duration =>
  BACKOFF[attempt] ?? Duration.seconds(5);
