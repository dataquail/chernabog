// The resolve-conflicts recipe end to end through the engine, on an in-memory
// GitHub: which of the persona's pull requests it picks up, and how it merges
// the base in, pushes, waits for CI and asks an approving reviewer again.

import { DEFAULT_LABELS, Implement, ownerMarker } from "@chernabog/sdk";
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

const keys = (fake: ReturnType<typeof makeFake>) =>
  Effect.map(flowTriggered(fake, resolveConflicts), (items) => items.map((found) => found.key));

describe("resolve-conflicts' flow", () => {
  effect("is one flow, run once at a time, on the persona's own work, behind the usage gate", () =>
    Effect.sync(() => {
      expect(Object.keys(resolveConflicts).toSorted()).toEqual([
        "concurrency",
        "gate",
        "ownWork",
        "trigger",
        "workflow",
      ]);
      expect(resolveConflicts.concurrency).toBe(1);
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
