// What the page holds from the daemon (stub).

import * as Duration from "effect/Duration";
import * as Option from "effect/Option";

import { type DaemonStatus } from "#daemon/protocol";

import { type FeedFailed, type Heard } from "./feed.ts";

export const REFETCH_AT_MOST_EVERY = Duration.millis(250);

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
  readonly refetching: boolean;
  readonly unreachable: number;
};

export type Message =
  | Heard
  | { readonly kind: "refetched"; readonly status: Option.Option<DaemonStatus> }
  | { readonly kind: "failed"; readonly failure: FeedFailed };

export const initial: Live = {
  status: Option.none(),
  connection: { kind: "connecting" },
  refetching: false,
  unreachable: 0,
};

export const hear = (live: Live, _message: Message) => ({
  live,
  refetchIn: Option.none<Duration.Duration>(),
});

export const reconnectDelay = (_attempt: number): Duration.Duration => Duration.zero;
