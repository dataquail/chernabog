import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type Persona } from "../../../../../kernel/persona.value-object.ts";
import { type NotificationsUnavailable } from "../../schedule/event-tick.errors.ts";

// One of a persona's GitHub notifications: the repo it's about, by owner/name,
// the issue or pull request, if it is one, why GitHub sent it
// (review_requested, author, assign, …) and when its thread last changed.
export type Notification = {
  readonly repo: string;
  readonly item: Option.Option<number>;
  readonly reason: string;
  readonly updatedAt: string;
};

// One poll of a persona's notifications. `changed` is false when GitHub
// answered that nothing changed since `lastModified` (a 304, which costs no
// rate limit); `pollInterval` is how long GitHub asks a poller to wait.
export type NotificationsPage = {
  readonly changed: boolean;
  readonly lastModified: Option.Option<string>;
  readonly pollInterval: Duration.Duration;
  readonly notifications: ReadonlyArray<Notification>;
};

// A persona's GitHub notifications, read and never marked read: a person's
// inbox stays theirs.
export type NotificationsClientService = {
  // The notifications whose threads changed since `since`, read or not,
  // unless GitHub says nothing changed after `lastModified`.
  readonly poll: (
    persona: Persona,
    lastModified: Option.Option<string>,
    since: string,
  ) => Effect.Effect<NotificationsPage, NotificationsUnavailable>;
};

export class NotificationsClient extends Context.Service<
  NotificationsClient,
  NotificationsClientService
>()("NotificationsClient") {}
