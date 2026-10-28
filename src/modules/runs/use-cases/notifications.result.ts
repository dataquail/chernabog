import * as Schema from "effect/Schema";

const Maybe = Schema.OptionFromNullOr(Schema.String);

// A notification about an enrolled repo, as a tick's cause: the repo by
// owner/name, what it says, such as "notification: review_requested on #73",
// and the issue or pull request it's about, if any.
export class NotificationNews extends Schema.Class<
  NotificationNews,
  { readonly brand: "NotificationNews" }
>("NotificationNews")({
  repo: Schema.String,
  cause: Schema.String,
  item: Schema.Option(Schema.Finite),
}) {}

// One poll of a persona's notifications: the news it had, where the next poll
// starts (`lastModified` and `since`), and how long to wait for it.
export class NotificationsPoll extends Schema.Class<
  NotificationsPoll,
  { readonly brand: "NotificationsPoll" }
>("NotificationsPoll")({
  news: Schema.Array(NotificationNews),
  lastModified: Maybe,
  since: Schema.String,
  pollIntervalMs: Schema.Finite,
}) {}
