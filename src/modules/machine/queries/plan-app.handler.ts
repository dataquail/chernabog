import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { GitHubAppsClient } from "../domain/ports/clients/github-apps.client.ts";
import { AppPlan, AppPlanFailed, type PlanAppPayload } from "./plan-app.query.ts";

// What each role's App may do on the repos it's installed on (#477). The
// reviewer writes contents only to chernabog/threads/*, which a ruleset holds
// it to, and only it writes checks: the check that gates a merge is its own.
// Neither touches .github/, so neither has workflows.
const PERMISSIONS: Readonly<Record<PlanAppPayload["role"], Readonly<Record<string, string>>>> = {
  author: {
    contents: "write",
    pull_requests: "write",
    issues: "write",
    checks: "read",
    actions: "read",
    statuses: "read",
    metadata: "read",
  },
  reviewer: {
    contents: "write",
    pull_requests: "write",
    issues: "write",
    checks: "write",
    actions: "read",
    statuses: "read",
    metadata: "read",
  },
};

// What each role's App's name ends in, after the prefix.
const SUFFIXES: Readonly<Record<PlanAppPayload["role"], string>> = {
  author: "-author",
  reviewer: "-review",
};

const DESCRIPTIONS: Readonly<Record<PlanAppPayload["role"], string>> = {
  author: "Chernabog's author: writes the code, opens and merges its pull requests.",
  reviewer: "Chernabog's reviewer: reviews the author's pull requests and gates them with a check.",
};

export const planAppHandler = Effect.fn("planAppHandler")(function* (query: PlanAppPayload) {
  const [owner] = query.repo.split("/");
  const prefix = Option.getOrElse(query.prefix, () => `${owner}-chernabog`);
  const name = `${prefix}${SUFFIXES[query.role]}`;

  const organization = yield* (yield* GitHubAppsClient)
    .ownerIsOrganization(owner)
    .pipe(
      Effect.mapError(
        (error) => new AppPlanFailed({ message: `whose is ${query.repo}? ${error.message}` }),
      ),
    );

  let newAppPage = "https://github.com/settings/apps/new";

  if (organization) {
    newAppPage = `https://github.com/organizations/${owner}/settings/apps/new`;
  }

  const home = `https://github.com/${query.repo}`;

  const manifest = {
    name,
    url: home,
    description: DESCRIPTIONS[query.role],
    public: false,
    // Workflows wake on the repo's own events: the App needs no webhook.
    hook_attributes: { url: home, active: false },
    redirect_url: `${query.origin}/created`,
    setup_url: `${query.origin}/installed`,
    // Adding a repo to an installation is an update: GitHub sends the person
    // back then too, so a second repo's setup hears of it.
    setup_on_update: true,
    request_oauth_on_install: false,
    default_events: [],
    default_permissions: PERMISSIONS[query.role],
  };

  return AppPlan.make({
    name,
    login: `${name}[bot]`,
    newAppPage,
    manifest: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(manifest).pipe(
      Effect.orDie,
    ),
  });
});
