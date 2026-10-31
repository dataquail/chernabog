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

// The status the daemon answered, over what the model showed. A daemon that
// has restarted has picked up every flow turned on or off from here.
export const withStatus = (model: Model, status: DaemonStatus): Model => {
  const sameDaemon = Option.exists(
    model.status,
    (previous) => previous.startedAt === status.startedAt && previous.pid === status.pid,
  );

  const pendingFlows = Option.getOrElse(
    Option.liftPredicate(model.pendingFlows, () => sameDaemon),
    () => ({}),
  );

  return { ...model, status: Option.some(status), error: Option.none(), pendingFlows };
};

const unchanged = (model: Model, live: Live): Fed => ({ model, live, refetchIn: Option.none() });

// What a message from the stream does. An event asks /status again
// REFETCH_AT_MOST_EVERY from now, unless a refetch is already on its way,
// which then answers for it too. A dropped stream keeps what the view knew
// and says it is reconnecting.
export const feed = (model: Model, live: Live, message: Feed): Fed => {
  switch (message.kind) {
    case "snapshot":
      return unchanged({ ...withStatus(model, message.status), reconnecting: false }, live);
    case "event":
      if (live.refetching) {
        return unchanged(model, live);
      }

      return { model, live: { refetching: true }, refetchIn: Option.some(REFETCH_AT_MOST_EVERY) };
    case "dropped":
      return unchanged(
        {
          ...model,
          reconnecting: true,
          error: Option.some(`${message.reason}. Reconnecting…`),
        },
        live,
      );
  }
};

// The refetch ran: the next event asks again.
export const refetched = (_live: Live): Live => quiet;

const BACKOFF = [Duration.seconds(1), Duration.seconds(2), Duration.seconds(4)];

// How long to wait before the attempt'th reconnect in a row, from 0.
export const reconnectDelay = (attempt: number): Duration.Duration =>
  BACKOFF[attempt] ?? Duration.seconds(5);
