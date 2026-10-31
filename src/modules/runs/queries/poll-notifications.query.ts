import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { NotificationsUnavailable } from "../domain/schedule/event-tick.errors.ts";
import { NotificationsPoll } from "../domain/schedule/notifications.value-object.ts";

// One poll of a persona's GitHub notifications: what changed since the
// cursor, about the repos given by owner/name, each as a tick's cause. It
// never decides what to do from a notification; a tick reads the real state.
// The cursor is where the poll starts: GitHub's Last-Modified from the last
// answer, and the newest thread change already heard.
export const PollNotificationsQuery = Query.make("PollNotificationsQuery", {
  payload: {
    persona: Schema.Option(Schema.String),
    cursor: Schema.Struct({
      lastModified: Schema.Option(Schema.String),
      since: Schema.String,
    }),
    repos: Schema.Array(Schema.String),
  },
  success: NotificationsPoll,
  failure: NotificationsUnavailable,
});

export type PollNotificationsPayload = Query.Payload<typeof PollNotificationsQuery>;
