import * as Schema from "effect/Schema";

// A persona's GitHub notifications can't be read, and what fixes it. Its flows
// go on ticking on cron meanwhile.
export class NotificationsUnavailable extends Schema.TaggedError<
  NotificationsUnavailable,
  { readonly brand: "NotificationsUnavailable" }
>()("NotificationsUnavailable", { reason: Schema.String, fix: Schema.String }) {
  public override get message() {
    return `${this.reason}; ${this.fix}`;
  }
}
