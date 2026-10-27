// The plan recipe through the engine, on an in-memory GitHub: a spec queued
// with auto:plan, the plan the agent drafts and the code checks, the wait for
// a person's answer, and the epic of sub-issues it makes once approved.

import {
  claimMarker,
  DEFAULT_LABELS,
  type Json,
  type LinkedIssue,
  Plan,
  planNodeMarker,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import implement from "../packages/recipes/flows/implement.ts";
import plan from "../packages/recipes/flows/plan.ts";
import { IMPLICIT } from "../src/kernel/persona.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsUseCase } from "../src/modules/runs/use-cases/list-run-waits.use-case.ts";
import { effect } from "./effect-test.ts";
import {
  deliverSignals,
  type Fake,
  flowTriggered,
  ISSUE,
  item,
  makeFake,
  repo,
  runUntil,
  summaryOf,
  triggered,
} from "./sdk-fakes.ts";

const planning = flowHandle(repo, "plan", plan);
const work = item(`issue-${ISSUE}`, { issue: ISSUE, label: Plan.LABELS.plan });

const task = (key: string, kind: string, blockedBy: ReadonlyArray<string> = []) => ({
  key,
  title: `Do ${key}`,
  body: `What ${key} is.`,
  kind,
  blockedBy: [...blockedBy],
});

const PLAN: Json = {
  status: "plan",
  summary: "The schema first, then the API on it; the name is a person's.",
  nodes: [
    task("api-schema", "auto"),
    task("api", "hybrid", ["api-schema"]),
    task("pick-name", "human"),
  ],
};

const queuedFake = () => {
  const fake = makeFake("approve");
  fake.setLabels(ISSUE, [Plan.LABELS.plan]);

  return fake;
};

// A person's answer to the posted plan, given once the run parks on it.
type Answer = (fake: Fake) => void;

const approve: Answer = (fake) => {
  fake.setLabels(ISSUE, [...fake.labelsOf(ISSUE), Plan.LABELS.approved]);
};

const askFor =
  (change: string): Answer =>
  (fake) => {
    fake.comment(change, "zach");
  };

// Runs the plan flow, and each time it parks on a plan, gives the next answer
// and delivers what the trigger then reports, as the daemon's ticks would:
// again on each poll until it wakes the run, since a run registers the waits
// of one awaitSignal one at a time.
const planWith = (fake: Fake, answers: ReadonlyArray<Answer>) => {
  let round = 0;
  let given = 0;

  return runUntil(planning, fake, work, (run) =>
    Effect.gen(function* () {
      if (run.status !== "running") {
        return true;
      }

      const { waits } = yield* listRunWaitsUseCase(run.id, "approved");
      const parked = waits.some((wait) => wait.deferred === `approved:plan-${round + 1}`);
      const answer = Arr.get(answers, round);

      if (parked && Option.isSome(answer)) {
        if (given === round) {
          given += 1;
          answer.value(fake);
        }

        const answered = yield* triggered(fake, Plan.answers).pipe(Effect.orDie);

        if ((yield* deliverSignals(planning, IMPLICIT, answered)) > 0) {
          round += 1;
        }
      }

      return false;
    }),
  );
};

// An issue already on GitHub, as an earlier run or a person left it.
const madeIssue = (
  number: number,
  body: string,
  state: LinkedIssue["state"] = "open",
): LinkedIssue => ({
  number,
  title: `Issue ${number}`,
  body,
  url: `https://github.com/dataquail/demo/issues/${number}`,
  createdAt: "2026-10-19T00:00:00Z",
  labels: [],
  assignees: [],
  state,
});

const madeIssues = (fake: Fake) =>
  [...fake.graph.made.values()].map((made) => ({
    number: made.number,
    title: made.title,
    key: Option.map(planNodeMarker.read(made.body), (marker) => marker.key),
    labels: fake.labelsOf(made.number),
  }));

describe("plan", () => {
  effect("finds specs labelled auto:plan, and wakes nothing until a person answers", () =>
    Effect.gen(function* () {
      const fake = queuedFake();
      expect((yield* flowTriggered(fake, plan)).map((found) => found.key)).toEqual([
        `issue-${ISSUE}`,
      ]);

      fake.setLabels(ISSUE, [DEFAULT_LABELS.inProgress, Plan.LABELS.proposed]);
      fake.comment(`## Proposed plan\n\n${'<!-- chernabog-plan {"round":1} -->'}`);
      expect(yield* triggered(fake, Plan.answers)).toEqual([]);

      fake.comment("Split the API in two.", "zach");
      expect(yield* triggered(fake, Plan.answers)).toEqual([
        expect.objectContaining({
          key: `issue-${ISSUE}`,
          signals: ["changes-requested"],
          wakeOnly: true,
        }),
      ]);

      approve(fake);
      expect((yield* triggered(fake, Plan.answers))[0]?.signals).toEqual(["approved"]);
    }),
  );

  effect(
    "posts the plan, and once approved makes each task a sub-issue, linked and labelled by kind",
    () =>
      Effect.gen(function* () {
        const fake = queuedFake();
        fake.plans.push(PLAN);
        const run = yield* planWith(fake, [approve]);

        expect(run.status).toBe("done");
        expect(summaryOf(run)).toBe(`#${ISSUE}: an epic of 4 sub-issues`);

        const posted = fake.comments.find((comment) => comment.body.includes("## Proposed plan"));
        expect(posted?.body).toContain("```mermaid");
        expect(posted?.body).toContain("verify: Verify: A queued issue (human)");

        const made = madeIssues(fake);
        expect(made.map((issue) => [issue.key, issue.labels])).toEqual([
          [Option.some("api-schema"), [DEFAULT_LABELS.eligible]],
          [Option.some("api"), []],
          [Option.some("pick-name"), [DEFAULT_LABELS.needsHuman]],
          [Option.some(Plan.VERIFY), [DEFAULT_LABELS.needsHuman]],
        ]);

        const [schema, api, name, verify] = made.map((issue) => issue.number);
        expect(fake.graph.subIssues.get(ISSUE)).toEqual([schema, api, name, verify]);
        expect(fake.graph.blockedBy.get(api)).toEqual([schema]);
        expect(fake.graph.blockedBy.get(verify)).toEqual([schema, api, name]);

        expect(fake.labelsOf(ISSUE)).toEqual([Plan.LABELS.epic]);
        expect(fake.removed).toEqual([Plan.planCheckout(ISSUE)]);
        expect(fake.comments.at(-1)?.body).toContain(`- #${api} \`api\`: Do api`);
      }),
  );

  effect("drafts the plan again with a person's comment, then makes the approved one", () =>
    Effect.gen(function* () {
      const fake = queuedFake();
      fake.plans.push(PLAN, { ...PLAN, nodes: [task("api-schema", "auto")] });
      const run = yield* planWith(fake, [askFor("Leave the API for later."), approve]);

      expect(run.status).toBe("done");
      expect(fake.steps).toEqual([Option.some("draft-plan-1"), Option.some("draft-plan-2")]);
      expect(fake.requests[1]?.resumePrompt).toEqual(
        Option.some(expect.stringContaining("zach: Leave the API for later.")),
      );
      expect(fake.comments.some((comment) => comment.body.includes("(round 2)"))).toBe(true);
      expect(madeIssues(fake).map((issue) => issue.key)).toEqual([
        Option.some("api-schema"),
        Option.some(Plan.VERIFY),
      ]);
    }),
  );

  effect("sends a plan that fails its checks back to the agent with what is wrong", () =>
    Effect.gen(function* () {
      const fake = queuedFake();
      fake.plans.push(
        { ...PLAN, nodes: [task("a", "auto", ["b"]), task("b", "auto", ["a"])] },
        PLAN,
      );
      const run = yield* planWith(fake, [approve]);

      expect(run.status).toBe("done");
      expect(fake.steps.slice(0, 2)).toEqual([
        Option.some("draft-plan-1"),
        Option.some("fix-plan-1-1"),
      ]);
      expect(fake.requests[1]?.resumePrompt).toEqual(
        Option.some(expect.stringContaining("blockedBy forms a cycle among `a`, `b`")),
      );
    }),
  );

  effect(
    "hands a plan that still fails after limits.planRounds to a person, and lets go of it",
    () =>
      Effect.gen(function* () {
        const fake = queuedFake();
        fake.plans.push({ ...PLAN, nodes: [task("verify", "auto")] });
        const run = yield* planWith(fake, []);

        expect(run.status).toBe("needs-human");
        expect(fake.steps).toEqual([
          Option.some("draft-plan-1"),
          Option.some("fix-plan-1-1"),
          Option.some("fix-plan-1-2"),
        ]);
        expect(fake.labelsOf(ISSUE)).toEqual([DEFAULT_LABELS.needsHuman]);
        expect(fake.comments.at(-1)?.body).toContain("still fails its checks after 2 attempts");
        expect(fake.graph.made.size).toBe(0);
        expect(fake.removed).toEqual([Plan.planCheckout(ISSUE)]);
      }),
  );

  effect("posts the agent's questions instead of a plan, and ends", () =>
    Effect.gen(function* () {
      const fake = queuedFake();
      fake.plans.push({
        status: "needs-clarification",
        summary: "The spec has no acceptance criteria.",
        nodes: [],
        questions: "1. What does done look like?",
      });
      const run = yield* planWith(fake, []);

      expect(run.status).toBe("needs-human");
      expect(fake.labelsOf(ISSUE)).toEqual([DEFAULT_LABELS.needsClarification]);
      expect(fake.comments.at(-1)?.body).toContain("1. What does done look like?");
      expect(fake.comments.at(-1)?.body).toContain("`auto:plan`");
      expect(fake.removed).toContain(Plan.planCheckout(ISSUE));
    }),
  );

  effect(
    "finds the issues a crashed run made by their markers, rather than making them twice",
    () =>
      Effect.gen(function* () {
        const fake = queuedFake();
        fake.plans.push(PLAN);
        // An earlier run of this plan made api-schema, and crashed before it was a sub-issue.
        fake.graph.made.set(
          90,
          madeIssue(
            90,
            `What api-schema is.\n\n${planNodeMarker.write({ spec: ISSUE, key: "api-schema" })}`,
          ),
        );

        const run = yield* planWith(fake, [approve]);

        expect(run.status).toBe("done");
        expect(
          madeIssues(fake)
            .filter((issue) => Option.contains(issue.key, "api-schema"))
            .map((issue) => issue.number),
        ).toEqual([90]);
        expect(fake.graph.subIssues.get(ISSUE)?.[0]).toBe(90);
      }),
  );

  effect("claims the spec as implement does", () =>
    Effect.gen(function* () {
      const fake = queuedFake();
      fake.plans.push(PLAN);
      yield* planWith(fake, [approve]);

      expect(fake.comments.some((comment) => Option.isSome(claimMarker.read(comment.body)))).toBe(
        true,
      );
    }),
  );
});

describe("implement, with a plan's tasks", () => {
  effect("leaves an issue an open issue blocks, and takes it once its blocker closes", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
      fake.graph.made.set(50, madeIssue(50, ""));
      fake.graph.blockedBy.set(ISSUE, [50]);
      expect(yield* flowTriggered(fake, implement)).toEqual([]);

      fake.graph.made.set(50, madeIssue(50, "", "closed"));
      expect((yield* flowTriggered(fake, implement)).map((found) => found.key)).toEqual([
        `issue-${ISSUE}`,
      ]);
    }),
  );
});
