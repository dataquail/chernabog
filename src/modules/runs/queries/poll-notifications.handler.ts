import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";

import { NotificationsClient } from "../domain/ports/clients/notifications.client.ts";
import { notificationCause } from "../domain/schedule/event-tick.value-object.ts";
import {
  NotificationNews,
  NotificationsPoll,
} from "../domain/schedule/notifications.value-object.ts";
import { type PollNotificationsPayload } from "./poll-notifications.query.ts";

export const pollNotificationsHandler = Effect.fn("pollNotificationsHandler")(function* ({
  cursor,
  persona,
  repos,
}: PollNotificationsPayload) {
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
        item: notification.item,
      }),
    ),
    lastModified: page.lastModified,
    since: Arr.reduce(page.notifications, cursor.since, (latest, notification) =>
      Order.max(Order.String)(latest, notification.updatedAt),
    ),
    pollIntervalMs: Duration.toMillis(page.pollInterval),
  });
});
