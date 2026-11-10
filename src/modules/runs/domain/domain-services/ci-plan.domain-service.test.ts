import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { type WorkItem } from "../run/work-item.value-object.ts";
import { CiPlan, type Findings, type LiveClaim, type Target } from "./ci-plan.domain-service.ts";

const item = (key: string, more: Partial<WorkItem> = {}): WorkItem => ({ key, data: {}, ...more });

const flows = [
  { flow: "implement", personas: ["bot"] },
  { flow: "review", personas: ["bot", "reviewer"] },
];

const every = (flow: string, persona: string): Target => ({ flow, persona, only: Option.none() });

const findings = (
  target: Target,
  items: ReadonlyArray<WorkItem>,
  more: Partial<Findings> = {},
): Findings => ({
  target,
  concurrency: 1,
  found: { kind: "items", items },
  held: Option.none(),
  ...more,
});

const claim = (key: string, flow: string, persona: string): LiveClaim => ({
  item: key,
  runId: `run-${key}`,
  flow,
  persona,
});

describe("what a plan looks at", () => {
  test("the sweep looks at every item of every CI flow, for each persona, in config's order", () => {
    expect(CiPlan.targets(flows, { kind: "sweep" })).toEqual([
      every("implement", "bot"),
      every("review", "bot"),
      every("review", "reviewer"),
    ]);
  });

  test("an event looks only at the flows and personas it wakes, and only at its item", () => {
    const targets = CiPlan.targets(flows, {
      kind: "event",
      woken: [{ flow: "review", persona: "Reviewer", item: { kind: "pull-request", number: 7 } }],
    });

    expect(targets).toEqual([
      {
        flow: "review",
        persona: "reviewer",
        only: Option.some([{ kind: "pull-request", number: 7 }]),
      },
    ]);
  });

  test("an event that names no one item looks at every item of the flows it wakes", () => {
    const targets = CiPlan.targets(flows, {
      kind: "event",
      woken: [
        { flow: "implement", persona: "bot", item: { kind: "issue", number: 3 } },
        { flow: "implement", persona: "bot", item: { kind: "repo" } },
      ],
    });

    expect(targets).toEqual([every("implement", "bot")]);
  });

  test("an event a guard refused wakes nothing, so the plan runs no trigger", () => {
    expect(CiPlan.targets(flows, { kind: "event", woken: [] })).toEqual([]);
  });

  test("an event for a flow that doesn't run in CI wakes nothing", () => {
    const targets = CiPlan.targets(flows, {
      kind: "event",
      woken: [{ flow: "epic", persona: "bot", item: { kind: "issue", number: 3 } }],
    });

    expect(targets).toEqual([]);
  });
});

describe("which items an event concerns", () => {
  test("an issue, by its key", () => {
    expect(CiPlan.concerns({ kind: "issue", number: 3 }, "issue-3")).toBe(true);
    expect(CiPlan.concerns({ kind: "issue", number: 3 }, "issue-30")).toBe(false);
    expect(CiPlan.concerns({ kind: "issue", number: 3 }, "pr-3")).toBe(false);
  });

  test("a pull request, by any key of its own", () => {
    expect(CiPlan.concerns({ kind: "pull-request", number: 7 }, "pr-7")).toBe(true);
    expect(CiPlan.concerns({ kind: "pull-request", number: 7 }, "pr-7-changes-2")).toBe(true);
    expect(CiPlan.concerns({ kind: "pull-request", number: 7 }, "pr-70")).toBe(false);
  });

  test("an item, by its claim's name or its key", () => {
    expect(CiPlan.concerns({ kind: "item", name: "pr-7" }, "pr-7-changes-asked-1a2b")).toBe(true);
    expect(CiPlan.concerns({ kind: "item", name: "epic-4" }, "epic-4")).toBe(true);
    expect(CiPlan.concerns({ kind: "item", name: "issue-4" }, "issue-5")).toBe(false);
  });

  test("a branch is resolved to its pull request, and an issue's work branch to the issue", () => {
    expect(CiPlan.resolveBranch("feature", Option.some(9))).toEqual([
      { kind: "pull-request", number: 9 },
    ]);
    expect(CiPlan.resolveBranch("auto/issue-12", Option.some(9))).toEqual([
      { kind: "pull-request", number: 9 },
      { kind: "issue", number: 12 },
    ]);
    expect(CiPlan.resolveBranch("feature", Option.none())).toEqual([]);
  });
});

describe("the plan", () => {
  test("starts nothing when there is nothing to look at", () => {
    const planned = CiPlan.plan([], []);

    expect(planned.start).toEqual([]);
    expect(CiPlan.matrix(planned.start)).toBe("[]");
  });

  test("starts the trigger's items in its order, up to the flow's concurrency", () => {
    const planned = CiPlan.plan(
      [
        findings(every("implement", "bot"), [item("issue-3"), item("issue-1"), item("issue-2")], {
          concurrency: 2,
        }),
      ],
      [],
    );

    expect(planned.start).toEqual([
      { flow: "implement", persona: "bot", item: "issue-3" },
      { flow: "implement", persona: "bot", item: "issue-1" },
    ]);
    expect(planned.notes).toEqual([
      "implement as bot: over its concurrency of 2; waiting: issue-2",
    ]);
  });

  test("a live claim by a run of the flow takes a slot, and its item starts no second run", () => {
    const planned = CiPlan.plan(
      [findings(every("implement", "bot"), [item("issue-3"), item("issue-4")])],
      [claim("issue-3", "implement", "bot")],
    );

    expect(planned.start).toEqual([]);
    expect(planned.notes).toEqual([
      "implement as bot: issue-3 has a run already (run-issue-3, implement as bot)",
      "implement as bot: at its concurrency of 1; waiting: issue-4",
    ]);
  });

  test("a claim names a pull request's item by the pull request", () => {
    const planned = CiPlan.plan(
      [findings(every("review", "bot"), [item("pr-7-changes-2"), item("pr-8")])],
      [claim("pr-7", "address-review", "bot")],
    );

    expect(planned.start).toEqual([{ flow: "review", persona: "bot", item: "pr-8" }]);
  });

  test("held items, those waiting on someone and those left for others start nothing, and say why", () => {
    const planned = CiPlan.plan(
      [
        findings(every("review", "bot"), [
          item("pr-1", { held: "the record says review-asked, but the pull request is closed" }),
          item("pr-2", { waitsOn: { who: "alice", why: "her review" } }),
          item("pr-3", { elsewhere: "assignee: bob" }),
          item("pr-4", { wakeOnly: true }),
          item("pr-5"),
        ]),
      ],
      [],
    );

    expect(planned.start).toEqual([{ flow: "review", persona: "bot", item: "pr-5" }]);
    expect(planned.notes).toEqual([
      "review as bot: pr-1 is held: the record says review-asked, but the pull request is closed",
      "review as bot: pr-2 waits on alice (her review)",
      "review as bot: left for others: pr-3 (assignee: bob)",
    ]);
  });

  test("an event's plan starts only the item it concerns", () => {
    const planned = CiPlan.plan(
      [
        findings(
          { flow: "implement", persona: "bot", only: Option.some([{ kind: "issue", number: 2 }]) },
          [item("issue-1"), item("issue-2")],
        ),
      ],
      [],
    );

    expect(planned.start).toEqual([{ flow: "implement", persona: "bot", item: "issue-2" }]);
  });

  test("an event's item its trigger doesn't report starts nothing, and says so", () => {
    const planned = CiPlan.plan(
      [
        findings(
          { flow: "implement", persona: "bot", only: Option.some([{ kind: "issue", number: 9 }]) },
          [item("issue-1")],
        ),
      ],
      [],
    );

    expect(planned.start).toEqual([]);
    expect(planned.notes).toEqual(["implement as bot: its trigger reports no work for issue-9"]);
  });

  test("an item another flow of this plan starts isn't started twice", () => {
    const planned = CiPlan.plan(
      [
        findings(every("implement", "bot"), [item("issue-3")]),
        findings(every("review", "bot"), [item("issue-3")]),
      ],
      [],
    );

    expect(planned.start).toEqual([{ flow: "implement", persona: "bot", item: "issue-3" }]);
    expect(planned.notes).toEqual(["review as bot: issue-3 is planned for implement as bot"]);
  });

  test("a flow whose gate holds it back, the usage gate among them, starts nothing, and says why", () => {
    const planned = CiPlan.plan(
      [
        findings(every("implement", "bot"), [item("issue-3")], {
          held: Option.some("usage gate: weekly headroom 0.010 is below the 0.050 task estimate"),
        }),
      ],
      [],
    );

    expect(planned.start).toEqual([]);
    expect(planned.notes).toEqual([
      "implement as bot: held back: usage gate: weekly headroom 0.010 is below the 0.050 task estimate; waiting: issue-3",
    ]);
  });

  test("a trigger that failed starts nothing, and says why", () => {
    const planned = CiPlan.plan(
      [
        {
          ...findings(every("implement", "bot"), []),
          found: { kind: "failed", reason: "GitHub answered 502" },
        },
      ],
      [],
    );

    expect(planned.start).toEqual([]);
    expect(planned.notes).toEqual(["implement as bot: trigger failed: GitHub answered 502"]);
  });

  test("what a flow could start, before its gate, so only those flows' gates are asked", () => {
    expect(
      CiPlan.startable(findings(every("implement", "bot"), [item("issue-3"), item("issue-4")]), [
        claim("issue-3", "implement", "bot"),
      ]).map((found) => found.key),
    ).toEqual(["issue-4"]);
  });
});
