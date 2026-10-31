// The post-merge recipe end to end through the engine, on an in-memory
// GitHub: which merged pull requests it watches, and what it does about the
// CI on their merge commits.

import { type CiReport, DEFAULT_LABELS } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import postMerge from "../packages/recipes/flows/post-merge.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { effect } from "./effect-test.ts";
import {
  flowTriggered,
  ISSUE,
  item,
  makeFake,
  PULL,
  repo,
  runToEnd,
  summaryOf,
} from "./sdk-fakes.ts";

const watching = flowHandle(repo, "post-merge", postMerge);

const MERGE = "merge5678";
const RUN = "https://github.com/dataquail/demo/actions/runs/41/job/42";

const work = item(`merged-${PULL}`, {
  pullRequest: PULL,
  url: `https://github.com/dataquail/demo/pull/${PULL}`,
  title: "feat: a change",
  mergeSha: MERGE,
  baseRef: "main",
  issue: ISSUE,
});

const red: CiReport = {
  state: "red",
  failedChecks: ["test"],
  failedRuns: [{ name: "test", url: RUN, job: Option.some(42), workflowRun: Option.some(41) }],
};

// The persona's pull request, merged a moment ago.
const mergedPull = (overrides: Parameters<typeof makeFake>[1] = {}) => {
  const fake = makeFake("approve", overrides);
  fake.states.pull = "merged";

  return fake;
};

const keys = (fake: ReturnType<typeof makeFake>) =>
  Effect.map(flowTriggered(fake, postMerge), (items) => items.map((found) => found.key));

// The issues the run filed, apart from the fake's queued one.
const filed = (fake: ReturnType<typeof makeFake>) => [...fake.graph.made.values()];

describe("post-merge's flow", () => {
  effect("is one flow, on the persona's own work, with no agent and so no usage gate", () =>
    Effect.sync(() => {
      expect(Object.keys(postMerge).toSorted()).toEqual([
        "concurrency",
        "labels",
        "ownWork",
        "settings",
        "trigger",
        "workflow",
      ]);
      expect(postMerge.ownWork).toBe(true);
    }),
  );

  effect("declares noCiGrace among its settings, and refuses one that isn't a duration", () =>
    Effect.gen(function* () {
      const schema = Option.fromUndefinedOr(postMerge.settings);
      expect(Option.isSome(schema)).toBe(true);

      for (const found of Option.toArray(schema)) {
        expect(yield* Schema.decodeEffect(found)({ noCiGrace: "3 minutes" })).toEqual(
          expect.objectContaining({ noCiGrace: "3 minutes" }),
        );
        expect(
          Exit.isFailure(yield* Effect.exit(Schema.decodeEffect(found)({ noCiGrace: "soon" }))),
        ).toBe(true);
      }
    }),
  );
});

describe("post-merge's trigger", () => {
  effect("picks up a pull request the persona wrote that merged into the base branch", () =>
    Effect.gen(function* () {
      const fake = mergedPull();
      const items = yield* flowTriggered(fake, postMerge);
      expect(items.map((found) => found.key)).toEqual([`merged-${PULL}`]);
      expect(items[0]?.data).toEqual(work.data);
    }),
  );

  effect("leaves one still open, and one closed without merging", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      expect(yield* keys(fake)).toEqual([]);
      fake.states.pull = "closed";
      expect(yield* keys(fake)).toEqual([]);
    }),
  );

  effect("leaves one another login wrote, one merged into another branch, and an old one", () =>
    Effect.gen(function* () {
      const fake = mergedPull();
      fake.authored.author = "zach";
      expect(yield* keys(fake)).toEqual([]);
      fake.authored.author = "chernabog-bot";

      fake.stack.base = "auto/issue-2";
      expect(yield* keys(fake)).toEqual([]);
      fake.stack.base = "main";

      fake.merged.at = "2026-01-01T00:00:00Z";
      expect(yield* keys(fake)).toEqual([]);
    }),
  );

  effect("watches each pull request once", () =>
    Effect.gen(function* () {
      const fake = mergedPull();
      const finished = yield* runToEnd(watching, fake, work);
      expect(finished.status).toBe("done");
      expect(yield* keys(fake)).toEqual([]);
    }),
  );
});

describe("post-merge", () => {
  effect("ends done when CI on the merge commit is green, and files nothing", () =>
    Effect.gen(function* () {
      const fake = mergedPull();
      const finished = yield* runToEnd(watching, fake, work);
      expect(finished.status).toBe("done");
      expect(summaryOf(finished)).toBe(`#${PULL}: CI on merge56 is green`);
      expect(fake.ciReads).toEqual([MERGE]);
      expect(filed(fake)).toEqual([]);
    }),
  );

  effect("ends done when no CI starts on the merge commit within the grace period", () =>
    Effect.gen(function* () {
      // The repo gives no CI no time to start.
      const [own] = repo.personas;

      const impatient = flowHandle(
        {
          ...repo,
          personas: [{ ...own, flows: { "post-merge": { settings: { noCiGrace: "0 millis" } } } }],
        },
        "post-merge",
        postMerge,
      );

      const fake = mergedPull();
      fake.commitCi.set(MERGE, { state: "pending", waitingOn: [], failedRuns: [] });
      const finished = yield* runToEnd(impatient, fake, work);
      expect(finished.status).toBe("done");
      expect(summaryOf(finished)).toBe(
        `#${PULL}: no CI ran on merge56 within 0; taken as none for this push`,
      );
      expect(filed(fake)).toEqual([]);
    }),
  );

  effect(
    "files one auto:eligible follow-up for a red merge commit, with the failed runs and their logs",
    () =>
      Effect.gen(function* () {
        const fake = mergedPull();
        fake.commitCi.set(MERGE, red);
        fake.logTails.set(RUN, "error: expected 2, got 3");
        const finished = yield* runToEnd(watching, fake, work);
        expect(finished.status).toBe("done");

        const [followUp, ...more] = filed(fake);
        expect(more).toEqual([]);
        expect(followUp.title).toBe(`CI is red on main after #${PULL} merged`);
        expect(fake.labelsOf(followUp.number)).toEqual([DEFAULT_LABELS.eligible]);
        expect(followUp.body).toContain(`https://github.com/dataquail/demo/pull/${PULL}`);
        expect(followUp.body).toContain(`[test](${RUN})`);
        expect(followUp.body).toContain("error: expected 2, got 3");
        expect(followUp.body).toContain("## Acceptance criteria");
        expect(followUp.body).toContain(`<!-- chernabog-post-merge {"sha":"${MERGE}"`);
        expect(summaryOf(finished)).toBe(
          `#${PULL}: CI on merge56 is red; filed #${followUp.number} to fix it`,
        );
        // The merged pull request links the follow-up.
        expect(fake.comments.some((comment) => comment.body.includes(`#${followUp.number}`))).toBe(
          true,
        );
      }),
  );

  effect("finds the follow-up it filed before a crash, and files no other", () =>
    Effect.gen(function* () {
      const fake = mergedPull();
      fake.commitCi.set(MERGE, red);
      fake.graph.made.set(100, {
        number: 100,
        title: `CI is red on main after #${PULL} merged`,
        body: `Filed earlier. <!-- chernabog-post-merge {"sha":"${MERGE}","pullRequest":${PULL}} -->`,
        url: "https://github.com/dataquail/demo/issues/100",
        createdAt: "2026-10-21T00:00:00Z",
        labels: [DEFAULT_LABELS.eligible],
        assignees: [],
        state: "open",
      });
      fake.graph.next = 101;

      const finished = yield* runToEnd(watching, fake, work);
      expect(finished.status).toBe("done");
      expect(filed(fake).map((issue) => issue.number)).toEqual([100]);
      expect(summaryOf(finished)).toBe(`#${PULL}: CI on merge56 is red; filed #100 to fix it`);
    }),
  );

  effect("hands a red merge of a follow-up's own fix to a person, not to another follow-up", () =>
    Effect.gen(function* () {
      const fake = mergedPull();
      fake.commitCi.set(MERGE, red);
      fake.issueText.body = `<!-- chernabog-post-merge {"sha":"older123","pullRequest":5} -->`;
      const finished = yield* runToEnd(watching, fake, work);
      expect(finished.status).toBe("done");

      const [followUp] = filed(fake);
      expect(fake.labelsOf(followUp.number)).toEqual([DEFAULT_LABELS.needsHuman]);
      expect(followUp.body).toContain(`#${ISSUE}`);
      expect(summaryOf(finished)).toBe(
        `#${PULL}: CI on merge56 is red after a follow-up's fix; filed #${followUp.number} for a person`,
      );
    }),
  );

  effect("files nothing when CI was already red on the commit before the merge", () =>
    Effect.gen(function* () {
      const fake = mergedPull();
      fake.commitCi.set(MERGE, red);
      fake.commitCi.set(fake.merged.parent, red);
      const finished = yield* runToEnd(watching, fake, work);
      expect(finished.status).toBe("done");
      expect(summaryOf(finished)).toBe(
        `#${PULL}: CI on merge56 is red, as it already was before the merge; filed nothing`,
      );
      expect(filed(fake)).toEqual([]);
    }),
  );
});
