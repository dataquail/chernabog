// What the live driver decides without GitHub (test/features/drivers/live-github.ts):
// when it's configured, which login each of the cast is, how GitHub's
// records read into the domain's terms, what a scenario cleans up, and that
// the cleanup and the scratch base never touch the default branch.

import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  castLogins,
  cleanupPlan,
  type Configured,
  configuredBy,
  guarded,
  type LiveConfig,
  type LiveRecords,
  mayCreate,
  poolProblems,
  SCRATCH_PREFIX,
  scratchBaseFor,
  sequenceAt,
  worldFrom,
} from "../features/drivers/live-github.ts";

const CONFIG: LiveConfig = {
  slug: "acme/scratch",
  writer: "acme-writer",
  reviewer: "acme-reviewer",
};

const cast = castLogins(CONFIG);

// Why the configuration can't run, when it can't.
const whyOf = (configured: Configured) => {
  switch (configured.kind) {
    case "misconfigured":
      return Option.some(configured.why);
    case "configured":
    case "unconfigured":
      return Option.none();
  }
};

describe("the live driver's configuration", () => {
  test("is none when neither variable is set", () => {
    expect(configuredBy(Option.none(), Option.none())).toEqual({ kind: "unconfigured" });
  });

  test("names the repo, then the writer's and the reviewer's logins", () => {
    expect(
      configuredBy(Option.some("acme/scratch"), Option.some("acme-writer, acme-reviewer")),
    ).toEqual({
      kind: "configured",
      config: CONFIG,
    });
  });

  test.each([
    ["no repo", Option.none(), Option.some("a,b")],
    ["a repo that isn't owner/name", Option.some("scratch"), Option.some("a,b")],
    ["no personas", Option.some("acme/scratch"), Option.none()],
    ["one persona", Option.some("acme/scratch"), Option.some("a")],
    ["three personas", Option.some("acme/scratch"), Option.some("a,b,c")],
    ["the same login twice", Option.some("acme/scratch"), Option.some("a,a")],
  ])("can't run with %s, and says how to", (_, repo, personas) => {
    const configured = configuredBy(repo, personas);

    expect(whyOf(configured)).toEqual(
      Option.some(expect.stringContaining("review-loop.live.feature.test.ts")),
    );
  });
});

describe("the cast's logins", () => {
  test("alice is the writer and bob the reviewer", () => {
    expect(cast.loginOf("alice")).toEqual(Option.some("acme-writer"));
    expect(cast.loginOf("bob")).toEqual(Option.some("acme-reviewer"));
  });

  test("nobody else has a login", () => {
    expect(cast.loginOf("carol")).toEqual(Option.none());
  });

  test("a login reads back as its name, whatever its case; another stays itself", () => {
    expect(cast.nameOf("Acme-Writer")).toBe("alice");
    expect(cast.nameOf("acme-reviewer")).toBe("bob");
    expect(cast.nameOf("dave")).toBe("dave");
  });

  test("who did something is a persona, or else a person", () => {
    expect(cast.actorOf(Option.some("acme-reviewer"))).toBe("bob");
    expect(cast.actorOf(Option.some("dave"))).toBe("a person");
    expect(cast.actorOf(Option.none())).toBe("a person");
  });
});

const AT = "2026-11-24T10:00:00Z";
const LATER = "2026-11-24T10:00:05Z";

const NONE: LiveRecords = {
  issues: [],
  pulls: [],
  reviews: [],
  comments: [],
  pushes: [],
  reviewRequests: [],
  labelled: [],
  sessions: [],
};

const PULL = {
  number: 7,
  author: "acme-writer",
  headRef: "auto/issue-3",
  headSha: "f1x",
  requested: ["acme-reviewer"],
  mergedBy: Option.none<string>(),
  mergedAt: Option.none<string>(),
};

describe("the world from GitHub's records", () => {
  test("a pull request is in the cast's names, for the issue its branch is for", () => {
    const world = worldFrom({ ...NONE, pulls: [PULL] }, cast);

    expect(world.pullRequests).toEqual([
      {
        number: 7,
        author: "alice",
        issue: Option.some(3),
        head: "f1x",
        requested: ["bob"],
        mergedBy: Option.none(),
      },
    ]);
  });

  test("a push is the pull request's by its branch, and by who pushed it", () => {
    const world = worldFrom(
      {
        ...NONE,
        pulls: [PULL],
        pushes: [
          {
            branch: "auto/issue-3",
            after: "f1x",
            actor: Option.some("acme-writer"),
            timestamp: AT,
          },
          { branch: "elsewhere", after: "abc", actor: Option.some("acme-writer"), timestamp: AT },
        ],
      },
      cast,
    );

    expect(world.pushes).toEqual([
      { pullRequest: 7, by: "alice", head: "f1x", sequence: sequenceAt(AT, "push") },
    ]);
  });

  test("in one second, a review is before the merge it allowed, and a push before it", () => {
    const world = worldFrom(
      {
        ...NONE,
        pulls: [{ ...PULL, mergedBy: Option.some("acme-reviewer"), mergedAt: Option.some(AT) }],
        reviews: [
          {
            pullRequest: 7,
            author: "acme-reviewer",
            state: "APPROVED",
            commitId: "f1x",
            submittedAt: AT,
            lineComments: 0,
          },
        ],
        pushes: [
          {
            branch: "auto/issue-3",
            after: "f1x",
            actor: Option.some("acme-writer"),
            timestamp: AT,
          },
        ],
      },
      cast,
    );

    expect(world.merges).toEqual([
      { pullRequest: 7, by: "bob", sequence: sequenceAt(AT, "merge") },
    ]);
    expect(world.reviews.map((review) => review.verdict)).toEqual(["approved"]);

    const order = [...world.pushes, ...world.reviews, ...world.merges].map(
      (event) => event.sequence,
    );

    expect(order).toEqual(order.toSorted((left, right) => left - right));
    expect(new Set(order).size).toBe(3);
  });

  test("an agent's session is before the push it made in the same second, whatever its milliseconds", () => {
    expect(sequenceAt("2026-11-24T10:00:00.400Z", "session")).toBeLessThan(
      sequenceAt("2026-11-24T10:00:00Z", "push"),
    );
  });

  test("a later second is later, whatever the kind", () => {
    expect(sequenceAt(AT, "merge")).toBeLessThan(sequenceAt(LATER, "session"));
  });

  test("replies, review requests and hand-offs read as the sandbox's do", () => {
    const world = worldFrom(
      {
        ...NONE,
        pulls: [PULL],
        comments: [
          {
            pullRequest: 7,
            author: "acme-writer",
            body: "Not addressing review 1: it's out of scope.",
            createdAt: AT,
          },
          { pullRequest: 7, author: "acme-writer", body: "Just a note.", createdAt: AT },
        ],
        reviewRequests: [
          {
            pullRequest: 7,
            reviewer: "acme-reviewer",
            actor: Option.some("acme-writer"),
            createdAt: AT,
          },
          { pullRequest: 7, reviewer: "dave", actor: Option.some("carol"), createdAt: LATER },
        ],
        labelled: [
          { pullRequest: 7, label: "auto:needs-human", createdAt: LATER },
          { pullRequest: 7, label: "auto:ship", createdAt: LATER },
        ],
      },
      cast,
    );

    expect(world.replies).toEqual([
      {
        pullRequest: 7,
        author: "alice",
        reasons: Option.some("it's out of scope."),
        sequence: sequenceAt(AT, "reply"),
      },
    ]);
    expect(world.reviewRequests.map(({ by, reviewer }) => ({ by, reviewer }))).toEqual([
      { by: "alice", reviewer: "bob" },
      { by: "a person", reviewer: "dave" },
    ]);
    expect(world.handOffs).toEqual([{ pullRequest: 7, sequence: sequenceAt(LATER, "handOff") }]);
  });

  test("an agent call is a persona's on the pull request of its branch, or of a push of its commit", () => {
    const world = worldFrom(
      {
        ...NONE,
        pulls: [PULL],
        pushes: [
          {
            branch: "auto/issue-3",
            after: "f1x",
            actor: Option.some("acme-writer"),
            timestamp: AT,
          },
        ],
        sessions: [
          {
            persona: Option.some("acme-writer"),
            session: "s1",
            resumed: false,
            branch: "auto/issue-3",
            head: "base",
            at: AT,
          },
          {
            persona: Option.some("acme-reviewer"),
            session: "s2",
            resumed: true,
            branch: "HEAD",
            head: "f1x",
            at: LATER,
          },
          {
            persona: Option.none(),
            session: "s3",
            resumed: false,
            branch: "auto/issue-3",
            head: "f1x",
            at: LATER,
          },
        ],
      },
      cast,
    );

    expect(
      world.sessions.map(({ persona, pullRequest, resumed, session }) => ({
        persona,
        pullRequest,
        resumed,
        session,
      })),
    ).toEqual([
      { persona: "alice", pullRequest: 7, resumed: false, session: "s1" },
      { persona: "bob", pullRequest: 7, resumed: true, session: "s2" },
    ]);
  });
});

const BASE = scratchBaseFor("ab12cd34");

describe("a scenario's cleanup", () => {
  const plan = cleanupPlan({
    scratchBase: BASE,
    issues: [{ number: 3, open: true }],
    pulls: [{ number: 7, headRef: "auto/issue-3", open: false }],
  });

  test("closes what is still open", () => {
    expect(plan.close).toEqual([{ kind: "issue", number: 3 }]);
  });

  test("deletes the work branch, the threads and claims of each item, then the scratch base", () => {
    expect(plan.deleteRefs).toEqual([
      "heads/auto/issue-3",
      "heads/chernabog/threads/issue-3",
      "heads/chernabog/threads/pr-7",
      "chernabog/claims/issue-3",
      "chernabog/claims/pr-7",
      `heads/${BASE}`,
    ]);
    expect(plan.deletePrefixes).toEqual(["chernabog/leases/issue-3/", "chernabog/leases/pr-7/"]);
  });

  test("passes its check when it leaves the default branch alone", () => {
    expect(guarded(plan, "main")).toEqual(Result.succeed(plan));
  });

  test("is refused when a pull request's head is the default branch", () => {
    const touching = cleanupPlan({
      scratchBase: BASE,
      issues: [],
      pulls: [{ number: 8, headRef: "main", open: true }],
    });

    const checked = guarded(touching, "main");

    expect(Result.getFailure(checked)).toEqual(Option.some(expect.stringContaining("heads/main")));
  });

  test("is refused when its base isn't a scratch branch", () => {
    const plain = cleanupPlan({ scratchBase: "main", issues: [], pulls: [] });

    expect(Result.isFailure(guarded(plain, "main"))).toBe(true);
    expect(Result.isFailure(guarded(plain, "trunk"))).toBe(true);
  });

  test("is refused when a prefix it empties would reach the default branch", () => {
    const sweeping = { ...plan, deletePrefixes: ["heads/"] };

    expect(Result.isFailure(guarded(sweeping, "main"))).toBe(true);
  });
});

describe("the scratch base", () => {
  test("is under the scratch prefix", () => {
    expect(BASE).toBe(`${SCRATCH_PREFIX}ab12cd34`);
    expect(mayCreate(BASE, "main")).toBe(true);
  });

  test("is never the default branch, nor a branch outside the prefix", () => {
    expect(mayCreate("main", "main")).toBe(false);
    expect(mayCreate("feature", "main")).toBe(false);
    expect(mayCreate(BASE, BASE)).toBe(false);
  });
});

describe("the team's reviewer pool", () => {
  test("names each persona the scenario has review", () => {
    expect(
      poolProblems("settings:\n  reviewers: [Acme-Writer, acme-reviewer]\n", [
        "acme-writer",
        "acme-reviewer",
      ]),
    ).toEqual([]);
  });

  test("may be config.yaml's deprecated reviewers", () => {
    expect(poolProblems("reviewers: [acme-reviewer]\n", ["acme-reviewer"])).toEqual([]);
  });

  test("says which reviewer it lacks", () => {
    expect(
      poolProblems("settings:\n  reviewers: [acme-writer]\n", ["acme-writer", "acme-reviewer"]),
    ).toEqual(["acme-reviewer isn't in .chernabog/config.yaml's settings.reviewers"]);
  });

  test("lacks everyone in a config with no pool, or none at all", () => {
    expect(poolProblems("settings: {}\n", ["acme-reviewer"])).toHaveLength(1);
    expect(poolProblems("", ["acme-reviewer"])).toHaveLength(1);
  });
});
