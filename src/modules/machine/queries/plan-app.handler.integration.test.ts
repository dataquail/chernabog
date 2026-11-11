import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { effectAtHome } from "../../../../test/effect-test.ts";
import { GitHubAppsClientFake } from "../infrastructure/clients/github-apps.client-fake.ts";
import { planAppHandler } from "./plan-app.handler.ts";

const origin = "http://127.0.0.1:5050";

const manifestOf = (plan: { readonly manifest: string }) =>
  Schema.decodeSync(Schema.fromJsonString(Schema.Json))(plan.manifest);

describe("planAppHandler", () => {
  effectAtHome("plans an organization's author App, named for its owner, with no webhook", () =>
    Effect.gen(function* () {
      const plan = yield* planAppHandler({
        role: "author",
        repo: "acme/widgets",
        prefix: Option.none(),
        origin,
      });

      expect(plan.name).toBe("acme-chernabog-author");
      expect(plan.login).toBe("acme-chernabog-author[bot]");
      expect(plan.newAppPage).toBe("https://github.com/organizations/acme/settings/apps/new");
      expect(manifestOf(plan)).toEqual({
        name: "acme-chernabog-author",
        url: "https://github.com/acme/widgets",
        description: "Chernabog's author: writes the code, opens and merges its pull requests.",
        public: false,
        hook_attributes: { url: "https://github.com/acme/widgets", active: false },
        redirect_url: "http://127.0.0.1:5050/created",
        setup_url: "http://127.0.0.1:5050/installed",
        setup_on_update: true,
        request_oauth_on_install: false,
        default_events: [],
        default_permissions: {
          contents: "write",
          pull_requests: "write",
          issues: "write",
          checks: "read",
          actions: "read",
          statuses: "read",
          metadata: "read",
        },
      });
    }).pipe(Effect.provide(GitHubAppsClientFake({ organizations: ["acme"] }))),
  );

  effectAtHome("plans a user's reviewer App under the prefix given, which writes checks", () =>
    Effect.gen(function* () {
      const plan = yield* planAppHandler({
        role: "reviewer",
        repo: "alice/notes",
        prefix: Option.some("chernabog"),
        origin,
      });

      expect(plan.name).toBe("chernabog-review");
      expect(plan.newAppPage).toBe("https://github.com/settings/apps/new");
      expect(manifestOf(plan)).toMatchObject({ default_permissions: { checks: "write" } });
      expect(plan.manifest).not.toContain("workflows");
    }).pipe(Effect.provide(GitHubAppsClientFake())),
  );
});
