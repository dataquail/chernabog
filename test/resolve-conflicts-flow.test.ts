// The resolve-conflicts recipe end to end through the engine, on an in-memory
// GitHub: which of the persona's pull requests it picks up, and how it merges
// the base in, pushes, waits for CI and asks an approving reviewer again.

import { DEFAULT_LABELS, Implement, ownerMarker, Review } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import resolveConflicts from "../packages/recipes/flows/resolve-conflicts.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { effect } from "./effect-test.ts";
import {
  flowTriggered,
  HEAD,
  item,
  makeFake,
  PULL,
  repo,
  runToEnd,
  stackOn,
  summaryOf,
} from "./sdk-fakes.ts";

const resolving = flowHandle(repo, "resolve-conflicts", resolveConflicts);

const work = item(`pr-${PULL}-${HEAD.slice(0, 7)}`, {
  pullRequest: PULL,
  headRef: "auto/issue-3",
  baseRef: "main",
});

// The persona's own pull request, which GitHub says conflicts with its base.
const conflicting = () => {
  const fake = makeFake("approve");
  fake.setLabels(PULL, []);
  fake.merge.state = "dirty";

  return fake;
};

// The persona's pull request, moved onto main after #2, the layer below,
// squash-merged there as `squash1`: its head, `below0000000`, is in the pull
// request's history, and `squash1` isn't.
const belowSquashed = () => {
  const fake = conflicting();
  stackOn(fake, "auto/issue-2", "merged");
  fake.stack.base = "main";
  fake.closed.push({
    number: 2,
    merged_at: "2026-10-31T17:09:00Z",
    merge_commit_sha: "squash1",
    head: { sha: "below0000000" },
  });
  fake.git.refuses.add("merge-base --is-ancestor squash1 HEAD");
  fake.git.says.set("rev-list --parents -n 1 squash1", "squash1 main0001\n");

  return fake;
};

const keys = (fake: ReturnType<typeof makeFake>) =>
  Effect.map(flowTriggered(fake, resolveConflicts), (items) => items.map((found) => found.key));

describe("resolve-conflicts' flow", () => {
  effect("is one flow, run once at a time, on the persona's own work, behind the usage gate", () =>
    Effect.sync(() => {
      expect(Object.keys(resolveConflicts).toSorted()).toEqual([
        "concurrency",
        "gate",
        "labels",
        "ownWork",
        "settings",
        "stillValid",
        "trigger",
        "workflow",
      ]);
      expect(resolveConflicts.concurrency).toBe(1);
      expect(resolveConflicts.stillValid).toBe(Review.stillValid);
      expect(resolveConflicts.ownWork).toBe(true);
      expect(resolveConflicts.gate).toBe(Implement.gate);
    }),
  );
});

describe("resolve-conflicts' trigger", () => {
  effect("picks up the persona's own pull request that conflicts with its base", () =>
    Effect.gen(function* () {
      const fake = conflicting();
      const items = yield* flowTriggered(fake, resolveConflicts);
      expect(items.map((found) => found.key)).toEqual([`pr-${PULL}-abc1234`]);
      expect(items.map((found) => found.data)).toEqual([
        { pullRequest: PULL, headRef: "auto/issue-3", baseRef: "main" },
      ]);
    }),
  );

  effect("keys the work by the head, so a conflict after a later push is new work", () =>
    Effect.gen(function* () {
      const fake = conflicting();
      fake.git.head = "fix20000000";
      expect(yield* keys(fake)).toEqual([`pr-${PULL}-fix2000`]);
    }),
  );

  effect("leaves one GitHub says is clean, or hasn't computed yet", () =>
    Effect.gen(function* () {
      const fake = conflicting();
      fake.merge.state = "clean";
      expect(yield* keys(fake)).toEqual([]);
      fake.merge.state = "unknown";
      expect(yield* keys(fake)).toEqual([]);
    }),
  );

  effect("leaves one a person has, one a run owns, and one another login wrote", () =>
    Effect.gen(function* () {
      const fake = conflicting();
      fake.setLabels(PULL, [DEFAULT_LABELS.needsHuman]);
      expect(yield* keys(fake)).toEqual([]);
      fake.setLabels(PULL, []);

      fake.people.me = "zach";
      expect(yield* keys(fake)).toEqual([]);
      fake.people.me = "chernabog-bot";

      fake.comment(ownerMarker.write({ flow: "implement", runId: "run-1", released: false }));
      expect(yield* keys(fake)).toEqual([]);
    }),
  );
});

describe("resolve-conflicts", () => {
  effect(
    "merges the base in, pushes, says so, waits for CI and asks the approving reviewer again",
    () =>
      Effect.gen(function* () {
        const fake = conflicting();
        fake.submitted.push({ author: "data-quail", state: "APPROVED", commitSha: HEAD });
        const finished = yield* runToEnd(resolving, fake, work);
        expect(finished.status).toBe("done");
        expect(summaryOf(finished)).toBe(
          `#${PULL}: merged main, resolved its conflicts and asked data-quail to review again`,
        );
        // Every placeholder the prompt names is filled.
        const [request] = fake.requests;
        expect(request.prompt).toContain("git merge --no-ff origin/main");
        expect(request.prompt).not.toMatch(/\{\{/);
        expect(fake.git.pushes).toBe(1);
        expect(
          fake.comments.some((comment) =>
            comment.body.startsWith("Merged `main` into this branch to resolve its conflicts."),
          ),
        ).toBe(true);
        expect(fake.people.requested).toEqual(["data-quail"]);
        expect(fake.labelsOf(PULL)).not.toContain(DEFAULT_LABELS.needsHuman);
      }),
  );

  effect("on a layer of a stack, merges in the layer below, not the repo's base branch", () =>
    Effect.gen(function* () {
      const fake = conflicting();
      fake.stack.base = "auto/issue-2";
      const [found] = yield* flowTriggered(fake, resolveConflicts);
      expect(found.data).toEqual({
        pullRequest: PULL,
        headRef: "auto/issue-3",
        baseRef: "auto/issue-2",
      });

      const finished = yield* runToEnd(resolving, fake, found);
      expect(summaryOf(finished)).toBe(`#${PULL}: merged auto/issue-2 and resolved its conflicts`);
      expect(fake.requests[0]?.prompt).toContain("git merge --no-ff origin/auto/issue-2");
      expect(fake.based.checkedAgainst).toEqual(["auto/issue-2", "auto/issue-2"]);
    }),
  );

  effect(
    "records a squash-merged layer below as already here, and merges nothing else when nothing else conflicts",
    () =>
      Effect.gen(function* () {
        const fake = belowSquashed();
        const finished = yield* runToEnd(resolving, fake, work);
        expect(finished.status).toBe("done");
        expect(fake.git.ran.filter((command) => command.startsWith("merge "))).toEqual([
          "merge --no-edit squash1~1",
          "merge --no-edit -s ours -m Merge squash1, the layer below as main merged it, already here squash1",
          "merge --no-edit origin/main",
        ]);
        // Recording it left nothing to resolve, so no agent ran.
        expect(fake.requests).toEqual([]);
        expect(fake.git.pushes).toBe(1);
        expect(
          fake.comments.some((comment) =>
            comment.body.includes("Recorded #2, the layer below as `main` merged it"),
          ),
        ).toBe(true);
      }),
  );

  effect("leaves the agent the merge in progress after recording a squash-merged layer below", () =>
    Effect.gen(function* () {
      const fake = belowSquashed();
      fake.git.refuses.add("merge --no-edit origin/main");
      fake.git.says.set("diff --name-only --diff-filter=U", "a.txt\n");
      const finished = yield* runToEnd(resolving, fake, work);
      expect(finished.status).toBe("done");
      const [request] = fake.requests;
      expect(request.prompt).toContain("The merge is already started");
      expect(request.prompt).toContain("#2, the layer below this pull request");
      expect(request.prompt).toContain("   - a.txt");
      expect(request.prompt).not.toContain("git merge --no-ff origin/main");
      expect(request.prompt).not.toMatch(/\{\{/);
      // The record finished, so the agent's commit is all that's left.
      expect(fake.requests).toHaveLength(1);
      expect(fake.git.pushes).toBe(1);
    }),
  );

  effect("merges again once the agent resolves a conflict that stopped the record short", () =>
    Effect.gen(function* () {
      const fake = belowSquashed();
      fake.git.refuses.add("merge --no-edit squash1~1");
      fake.git.says.set("diff --name-only --diff-filter=U", "a.txt\n");
      const finished = yield* runToEnd(resolving, fake, work);
      expect(finished.status).toBe("done");
      // Each of the two merges is left to the agent: git here conflicts the same way twice.
      expect(fake.requests).toHaveLength(2);
      expect(
        fake.git.ran.filter((command) => command === "merge --no-edit squash1~1"),
      ).toHaveLength(2);
    }),
  );

  effect("asks no one when the latest decisive review is no approval", () =>
    Effect.gen(function* () {
      const fake = conflicting();
      fake.submitted.push(
        { author: "data-quail", state: "APPROVED", commitSha: HEAD },
        { author: "data-quail", state: "CHANGES_REQUESTED", commitSha: HEAD },
      );
      const finished = yield* runToEnd(resolving, fake, work);
      expect(summaryOf(finished)).toBe(`#${PULL}: merged main and resolved its conflicts`);
      expect(fake.git.pushes).toBe(1);
      expect(fake.people.requested).toEqual([]);
    }),
  );

  effect("asks no one on a pull request with no review", () =>
    Effect.gen(function* () {
      const fake = conflicting();
      const finished = yield* runToEnd(resolving, fake, work);
      expect(finished.status).toBe("done");
      expect(fake.people.requested).toEqual([]);
    }),
  );

  effect("hands a conflict only a person can settle to a person, without pushing", () =>
    Effect.gen(function* () {
      const fake = conflicting();
      fake.author.resolve = "needs-human";
      const finished = yield* runToEnd(resolving, fake, work);
      expect(finished.status).toBe("needs-human");
      expect(summaryOf(finished)).toContain("the merge conflict needs a person");
      expect(fake.git.pushes).toBe(0);
      expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.needsHuman);
    }),
  );
});
