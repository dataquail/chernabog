// The team's GitHub Apps in config.yaml (#477): apps: names each role's App,
// a flow acts as one with as:, and a reviewer pool names the reviewer App as
// app:reviewer, which is never asked for a review: it reviews through its check.

import { defineFlow, PullRequest } from "@chernabog/sdk";
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

// The bots the Apps act as, which personas: lists by hand.
const BOTS = ["chernabog-author[bot]", "chernabog-review[bot]"];

const REVIEWER = { id: 5714350, slug: "chernabog-review", login: "chernabog-review[bot]" };

describe("the team's GitHub Apps in config.yaml", () => {
  effect("flows act as the Apps apps: names, and a pool names the reviewer App", () =>
    Effect.sync(() => {
      const repo = config({
        apps: APPS,
        personas: BOTS,
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
        personas: ["chernabog-author[bot]"],
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

  effect("an App whose bot personas: doesn't list is refused", () =>
    Effect.sync(() => {
      const repo = config({ apps: APPS, personas: ["Chernabog-Author[bot]", "alice"] });

      expect(appsProblems(repo)).toEqual([
        "apps.reviewer acts as chernabog-review[bot], but personas: doesn't list it; add chernabog-review[bot] to personas:",
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

// A flow that says whether the pull request has a reviewer, which decides
// whether its hand-off records it unasked (projecting needs-review).
const checking = defineFlow({
  trigger: Effect.succeed([]),
  workflow: () =>
    PullRequest.hasReviewer(PULL).pipe(
      Effect.map((has) => [`unasked`, `has a reviewer`][Number(has)]),
      Effect.orDie,
    ),
});

// Runs `flow` on the fake's pull request, with this pool.
const runWith = (reviewers: ReadonlyArray<string>, name: string, flow: typeof asking) =>
  Effect.gen(function* () {
    const pool = { ...settings, reviewers, apps: { reviewer: REVIEWER } };
    const fake = makeFake("approve", pool);
    const run = yield* runToEnd(flowHandle(repoAs(pool), name, flow), fake, item("pr"));

    return { fake, run };
  });

const askWith = (reviewers: ReadonlyArray<string>) => runWith(reviewers, "asking", asking);

describe("asking the reviewer pool for a review", () => {
  effect("a pool of only the reviewer App asks no one", () =>
    Effect.gen(function* () {
      const { fake, run } = yield* askWith(["app:reviewer"]);

      expect(summaryOf(run)).toBe(
        `#${PULL}: left for chernabog-review[bot], which reviews through its check`,
      );
      expect(fake.people.requested).toEqual([]);
    }),
  );

  effect("a pool of only the reviewer App has a reviewer, so the hand-off isn't unasked", () =>
    Effect.gen(function* () {
      const { run } = yield* runWith(["app:reviewer"], "checking", checking);

      expect(summaryOf(run)).toBe("has a reviewer");
    }),
  );

  effect("an empty pool has no reviewer, and the hand-off is unasked", () =>
    Effect.gen(function* () {
      const { run } = yield* runWith([], "checking", checking);

      expect(summaryOf(run)).toBe("unasked");
    }),
  );

  effect("with people in the pool beside the App, one of the people is asked", () =>
    Effect.gen(function* () {
      const { fake } = yield* askWith(["app:reviewer", "alice"]);

      expect(fake.people.requested).toEqual(["alice"]);
    }),
  );
});
