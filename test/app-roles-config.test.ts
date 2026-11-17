// The team's GitHub Apps in config.yaml (#477): apps: names each role's App,
// a flow acts as one with as:, and a reviewer pool names the reviewer App as
// app:reviewer, which is never asked for a review: it reviews through its check.

import { DEFAULT_LABELS, defineFlow, PullRequest } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { appsProblems, RepoConfigFile } from "../src/repo-config.ts";
import { effect } from "./effect-test.ts";
import { item, makeFake, PULL, repoAs, runToEnd, settings, summaryOf } from "./sdk-fakes.ts";

const config = Schema.decodeUnknownSync(RepoConfigFile);

const APPS = {
  author: { id: 5714322, slug: "chernabog-author" },
  reviewer: { id: 5714350, slug: "chernabog-review" },
};

const REVIEWER = { id: 5714350, slug: "chernabog-review", login: "chernabog-review[bot]" };

describe("the team's GitHub Apps in config.yaml", () => {
  effect("flows act as the Apps apps: names, and a pool names the reviewer App", () =>
    Effect.sync(() => {
      const repo = config({
        apps: APPS,
        settings: { reviewers: ["app:reviewer", "alice"] },
        flows: { implement: { as: "author" }, review: { as: "reviewer" } },
      });

      expect(appsProblems(repo)).toEqual([]);
    }),
  );

  effect("a flow acting as, or a pool naming, a role apps: has no App for is refused", () =>
    Effect.sync(() => {
      const repo = config({
        apps: { author: APPS.author },
        reviewers: ["app:reviewer"],
        flows: {
          review: { as: "reviewer", settings: { reviewers: ["app:nobody", "alice"] } },
        },
      });

      expect(appsProblems(repo)).toEqual([
        "flows.review.as: reviewer, but apps: has no reviewer App",
        "reviewers: app:reviewer, but apps: has no reviewer App",
        "flows.review.settings.reviewers: app:nobody names no App role; use app:author or app:reviewer",
      ]);
    }),
  );

  effect("as: is only author or reviewer", () =>
    Effect.sync(() => {
      expect(() => config({ flows: { review: { as: "approver" } } })).toThrow();
    }),
  );

  effect("a repo without apps: has nothing to refuse, as before", () =>
    Effect.sync(() => {
      expect(appsProblems(config({ reviewers: ["alice", "bob"] }))).toEqual([]);
    }),
  );
});

// A flow that only asks the pool to review the pull request.
const asking = defineFlow({
  trigger: Effect.succeed([]),
  workflow: () => PullRequest.requestReview(PULL).pipe(Effect.orDie),
});

// Asks for a review of the fake's pull request, with this pool.
const askWith = (reviewers: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const pool = { ...settings, reviewers, apps: { reviewer: REVIEWER } };
    const fake = makeFake("approve", pool);
    fake.labelsOf(PULL).splice(0);
    const run = yield* runToEnd(flowHandle(repoAs(pool), "asking", asking), fake, item("pr"));

    return { fake, run };
  });

describe("asking the reviewer pool for a review", () => {
  effect("a pool of only the reviewer App asks no one, and labels nothing for a person", () =>
    Effect.gen(function* () {
      const { fake, run } = yield* askWith(["app:reviewer"]);

      expect(summaryOf(run)).toBe(
        `#${PULL}: left for chernabog-review[bot], which reviews through its check`,
      );
      expect(fake.people.requested).toEqual([]);
      expect(fake.labelsOf(PULL)).not.toContain(DEFAULT_LABELS.needsReview);
    }),
  );

  effect("with people in the pool beside the App, one of the people is asked", () =>
    Effect.gen(function* () {
      const { fake } = yield* askWith(["app:reviewer", "alice"]);

      expect(fake.people.requested).toEqual(["alice"]);
    }),
  );
});
