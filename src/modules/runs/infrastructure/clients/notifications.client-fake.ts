import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import {
  type Notification,
  NotificationsClient,
} from "../../domain/ports/clients/notifications.client.ts";
import { NotificationsUnavailable } from "../../domain/schedule/event-tick.errors.ts";

// What a test's personas have, by login ("" for the implicit one): their
// notifications, which persona's poll fails and why, and the polls asked for.
export type FakeInbox = {
  readonly notifications: Record<string, ReadonlyArray<Notification>>;
  readonly failing: Record<string, string>;
  readonly polled: Array<{ readonly login: string; readonly since: string }>;
};

export const fakeInbox = (held: Partial<FakeInbox> = {}): FakeInbox => ({
  notifications: {},
  failing: {},
  polled: [],
  ...held,
});

// Answers each poll with the notifications updated after `since`, and as
// unchanged when there are none.
export const NotificationsClientFake = (inbox: FakeInbox) =>
  Layer.succeed(
    NotificationsClient,
    NotificationsClient.of({
      poll: (persona, lastModified, since) =>
        Effect.gen(function* () {
          const login = Option.getOrElse(persona, () => "");
          inbox.polled.push({ login, since });

          for (const reason of Option.toArray(Record.get(inbox.failing, login))) {
            return yield* new NotificationsUnavailable({ reason, fix: "fix it" });
          }

          const notifications = Option.getOrElse(
            Record.get(inbox.notifications, login),
            (): ReadonlyArray<Notification> => [],
          ).filter((notification) => notification.updatedAt > since);

          return {
            changed: notifications.length > 0,
            lastModified,
            pollInterval: Duration.seconds(60),
            notifications,
          };
        }),
    }),
  );
