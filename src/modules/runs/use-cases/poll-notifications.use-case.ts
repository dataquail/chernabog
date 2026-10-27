import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Order from "effect/Order";

import { type Persona } from "../../../kernel/persona.value-object.ts";
import { NotificationsClient } from "../domain/ports/clients/notifications.client.ts";
import { notificationCause } from "../domain/schedule/event-tick.value-object.ts";
import { NotificationNews, NotificationsPoll } from "./notifications.result.ts";

// Where a persona's poll of its notifications starts: GitHub's Last-Modified
// from the last answer, and the newest thread change already heard.
export type NotificationsCursor = {
  readonly lastModified: Option.Option<string>;
  readonly since: string;
};

// One poll of a persona's GitHub notifications: what changed since the
// cursor, about the repos given by owner/name, each as a tick's cause. It
// never decides what to do from a notification; a tick reads the real state.
export const pollNotificationsUseCase = Effect.fn("pollNotificationsUseCase")(function* (
  persona: Persona,
  cursor: NotificationsCursor,
  repos: ReadonlyArray<string>,
) {
  const page = yield* (yield* NotificationsClient).poll(persona, cursor.lastModified, cursor.since);
  const enrolled = new Set(repos.map((repo) => repo.toLowerCase()));

  // Threads GitHub returns from `since` on, so one changed at `since` was heard.
  const fresh = page.notifications.filter(
    (notification) =>
      notification.updatedAt > cursor.since && enrolled.has(notification.repo.toLowerCase()),
  );

  return NotificationsPoll.make({
    news: fresh.map((notification) =>
      NotificationNews.make({
        repo: notification.repo,
        cause: notificationCause(notification.reason, notification.item),
      }),
    ),
    lastModified: page.lastModified,
    since: Arr.reduce(page.notifications, cursor.since, (latest, notification) =>
      Order.max(Order.String)(latest, notification.updatedAt),
    ),
    pollIntervalMs: Duration.toMillis(page.pollInterval),
  });
});
