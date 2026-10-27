// The plan recipe's checks and what it writes, apart from any run: what is
// wrong with a plan, the verify task the code adds, and the comment a person
// approves.

import { type Issue, Plan, planMarker } from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

const node = (
  key: string,
  blockedBy: ReadonlyArray<string> = [],
  kind = "auto",
): Plan.PlanNode => ({
  key,
  title: `Do ${key}`,
  body: `What ${key} is.`,
  kind,
  blockedBy,
});

const spec = (body: string): Issue => ({
  number: 3,
  title: "A spec",
  body,
  url: "https://github.com/dataquail/demo/issues/3",
  createdAt: "2026-10-20T00:00:00Z",
  labels: [],
  assignees: [],
});

describe("checkPlan", () => {
  test("passes a plan whose tasks block only tasks it has, without a cycle", () => {
    expect(
      Plan.checkPlan([node("api-schema"), node("api", ["api-schema"]), node("ui", ["api"])], 12),
    ).toEqual([]);
  });

  test("refuses an empty plan, and one with more tasks than the limit", () => {
    expect(Plan.checkPlan([], 12)).toEqual(["the plan has no tasks"]);
    expect(Plan.checkPlan([node("a"), node("b"), node("c")], 2)).toEqual([
      "the plan has 3 tasks, and may have at most 2",
    ]);
  });

  test("names keys that repeat, can't be used, or are kept for the verify task", () => {
    expect(Plan.checkPlan([node("a"), node("a"), node("Bad Key"), node("verify")], 12)).toEqual([
      "key `a` names more than one task",
      "key `Bad Key` must be lowercase letters, digits and dashes",
      "key `verify` is kept for the verify task Chernabog adds",
    ]);
  });

  test("names unknown kinds, missing titles, and blockers no task is", () => {
    expect(
      Plan.checkPlan([node("a", [], "robot"), { ...node("b", ["nowhere"]), title: " " }], 12),
    ).toEqual([
      "task `a` has kind `robot`; it must be auto, hybrid or human",
      "task `b` has no title",
      "task `b` is blocked by `nowhere`, which no task is",
    ]);
  });

  test("names the tasks a cycle holds, and those waiting on it", () => {
    expect(
      Plan.checkPlan([node("a", ["c"]), node("b", ["a"]), node("c", ["b"]), node("d", ["c"])], 12),
    ).toEqual(["blockedBy forms a cycle among `a`, `b`, `c`, `d`"]);
    expect(Plan.checkPlan([node("a", ["a"])], 12)).toEqual(["blockedBy forms a cycle among `a`"]);
  });
});

describe("the verify task", () => {
  test("takes the spec's acceptance criteria, up to the next heading at its level", () => {
    expect(
      Plan.acceptanceCriteria(
        "## Problem\n\nIt's slow.\n\n## Acceptance criteria\n\n- fast\n\n### Detail\n\nstill in\n\n## Questions\n\nnot in",
      ),
    ).toEqual(Option.some("- fast\n\n### Detail\n\nstill in"));
    expect(Plan.acceptanceCriteria("### Acceptance Criteria\n- to the end")).toEqual(
      Option.some("- to the end"),
    );
    expect(Plan.acceptanceCriteria("No such heading.")).toEqual(Option.none());
  });

  test("is a person's, last, and blocked by every other task", () => {
    const plan = Plan.withVerify(spec("## Acceptance criteria\n\n- it works"), [
      node("a"),
      node("b", ["a"]),
    ]);

    const verify = plan[2];
    expect(plan.map((task) => task.key)).toEqual(["a", "b", Plan.VERIFY]);
    expect(verify.kind).toBe("human");
    expect(verify.blockedBy).toEqual(["a", "b"]);
    expect(verify.title).toBe("Verify: A spec");
    expect(verify.body).toContain("## Acceptance criteria\n\n- it works");
  });

  test("checks against the whole spec when it names no criteria", () => {
    expect(Plan.withVerify(spec("Make it fast."), [node("a")])[1]?.body).toContain(
      "#3 names none under that heading: check the work against the whole spec.",
    );
  });
});

describe("the plan's comment", () => {
  test("draws what blocks what, folds each task, says how to answer, and marks its round", () => {
    const comment = Plan.planComment(2, "Schema, then the API.", [
      node("api-schema"),
      { ...node("api", ["api-schema"]), title: 'The "real" API' },
    ]);

    expect(comment).toContain("## Proposed plan (round 2)");
    expect(comment).toContain(
      [
        "```mermaid",
        "graph TD",
        '  t1["api-schema: Do api-schema (auto)"]',
        '  t2["api: The #quot;real#quot; API (auto)"]',
        "  t1 --> t2",
        "```",
      ].join("\n"),
    );
    expect(comment).toContain("<details><summary><code>api</code>");
    expect(comment).toContain("Blocked by `api-schema`.");
    expect(comment).toContain("`auto:plan-approved`");
    expect(planMarker.read(comment)).toEqual(Option.some({ round: 2 }));
  });
});
