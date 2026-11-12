// The plan job's summary (#465): a phase announcement's repository_dispatch
// shows its client_payload there, since GitHub's API doesn't show it for the
// run it starts.

import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { summaryOf } from "../src/interface/cli/ci.main.ts";

const plan = {
  scope: "repository_dispatch chernabog-phase",
  start: [{ flow: "review", persona: "review-bot", item: "pr-175" }],
  matrix: '[{"flow":"review","persona":"review-bot","item":"pr-175"}]',
  notes: [],
  maxParallel: 2,
};

describe("the plan job's summary", () => {
  test("a phase announcement's dispatch shows its payload", () => {
    const summary = summaryOf(
      plan,
      Option.some({
        name: "repository_dispatch",
        payload: {
          action: "chernabog-phase",
          client_payload: { item: "pr-175", from: "implementing", to: "review-asked" },
        },
      }),
    );

    expect(summary).toContain(
      'Payload: `{"item":"pr-175","from":"implementing","to":"review-asked"}`',
    );
  });

  test("another event shows no payload", () => {
    const summary = summaryOf(
      { ...plan, scope: "issues labeled" },
      Option.some({ name: "issues", payload: { action: "labeled", client_payload: { x: 1 } } }),
    );

    expect(summary).not.toContain("Payload:");
  });

  test("the sweep shows no payload", () => {
    expect(summaryOf({ ...plan, scope: "sweep" }, Option.none())).not.toContain("Payload:");
  });
});
