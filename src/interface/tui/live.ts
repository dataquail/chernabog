// How the live view follows the daemon over GET /events: the stream's
// snapshot replaces the status it shows, and each event after it asks /status
// again, once for a burst. Pure, so the TUI's loop (app.ts) only carries it out.

import * as Duration from "effect/Duration";
import * as Option from "effect/Option";

import type { DaemonEvent, DaemonStatus } from "../daemon/daemon.protocol.ts";
import type { Model } from "./view.ts";

// The most often the live view asks /status again for what events said.
export const REFETCH_AT_MOST_EVERY = Duration.millis(250);

// What the stream says to the live view: its snapshot, an event after it, or
// that it dropped.
export type Feed =
  | { readonly kind: "snapshot"; readonly status: DaemonStatus }
  | { readonly kind: "event"; readonly event: DaemonEvent }
  | { readonly kind: "dropped"; readonly reason: string };

// Whether a refetch is already on its way.
export type Live = { readonly refetching: boolean };

export const quiet: Live = { refetching: false };

export type Fed = {
  readonly model: Model;
  readonly live: Live;
  // How long from now to ask /status again, when this asks it.
  readonly refetchIn: Option.Option<Duration.Duration>;
};

export const feed = (model: Model, live: Live, _message: Feed): Fed => ({
  model,
  live,
  refetchIn: Option.none(),
});

export const refetched = (live: Live): Live => live;

export const reconnectDelay = (_attempt: number): Duration.Duration => Duration.zero;
