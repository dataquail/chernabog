import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

// What GitHub's new-App page is to be sent for one role's App (#481): the
// page, for an organization or a user, and the manifest to post to it, as
// JSON. The App's name is what the person sees there and can change; the bot
// it makes is login, unless they do.
export class AppPlan extends Schema.Class<AppPlan, { readonly brand: "AppPlan" }>("AppPlan")({
  name: Schema.String,
  login: Schema.String,
  newAppPage: Schema.String,
  manifest: Schema.String,
}) {}

// GitHub couldn't say whose the repo is.
export class AppPlanFailed extends Schema.TaggedError<
  AppPlanFailed,
  { readonly brand: "AppPlanFailed" }
>()("AppPlanFailed", { message: Schema.String }) {}

// One role's App for a repo: named `<prefix>-author` or `<prefix>-review`
// (prefix `<owner>-chernabog` unless given, since an App's name is unique
// across GitHub), coming back to `origin`, the command's listener, once it's
// made and once it's installed.
export const PlanAppQuery = Query.make("PlanAppQuery", {
  payload: {
    role: Schema.Literals(["author", "reviewer"]),
    repo: Schema.String,
    prefix: Schema.Option(Schema.String),
    origin: Schema.String,
  },
  success: AppPlan,
  failure: AppPlanFailed,
});

export type PlanAppPayload = Query.Payload<typeof PlanAppQuery>;
