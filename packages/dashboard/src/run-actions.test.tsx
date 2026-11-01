// The buttons that act on runs, rendered in each state: what they offer, the
// confirmation before a cancel, and the daemon's refusal beside the button.

import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import { renderToStaticMarkup } from "react-dom/server";

import type { RepoStatus } from "#daemon/protocol";

import type { Outcome } from "./actions.ts";
import { AttachControl, CancelControl, type Draft, RunNowForm } from "./run-actions.tsx";

type FlowFields = Partial<RepoStatus["flows"][number]>;

const flow = (fields: FlowFields): RepoStatus["flows"][number] => ({
  name: "implement",
  schedule: "*/5 * * * *",
  next: Option.none(),
  lastTick: Option.none(),
  enabled: true,
  queued: [],
  ...fields,
});

const repo = (flows: RepoStatus["flows"]): RepoStatus => ({
  name: "api",
  slug: "acme/api",
  status: "ready",
  message: Option.none(),
  paused: false,
  enabled: true,
  tree: Option.none(),
  launcher: Option.none(),
  flows,
});

const draft = (fields: Partial<Draft> = {}): Draft => ({
  flow: "implement",
  persona: Option.none(),
  item: "",
  ...fields,
});

const nothing = () => {};

const refused = (message: string): Option.Option<Outcome> =>
  Option.some({ kind: "refused", message });

const runNow = (
  shown: RepoStatus,
  fields: Partial<Draft> = {},
  outcome: Option.Option<Outcome> = Option.none(),
) =>
  renderToStaticMarkup(
    <RunNowForm
      repo={shown}
      draft={draft(fields)}
      pending={false}
      outcome={outcome}
      onDraft={nothing}
      onSubmit={nothing}
    />,
  );

const cancel = (
  confirming: boolean,
  outcome: Option.Option<Outcome> = Option.none(),
  closeSessions = false,
) =>
  renderToStaticMarkup(
    <CancelControl
      label="api/implement issue-7"
      confirming={confirming}
      closeSessions={closeSessions}
      pending={false}
      outcome={outcome}
      onAsk={nothing}
      onCloseSessions={nothing}
      onConfirm={nothing}
      onKeep={nothing}
    />,
  );

const attach = (opens: boolean, outcome: Option.Option<Outcome> = Option.none()) =>
  renderToStaticMarkup(
    <AttachControl
      opens={opens}
      pending={false}
      outcome={outcome}
      onCopy={nothing}
      onOpen={nothing}
    />,
  );

describe("run now", () => {
  test("offers the repo's flows that are on, an item, and no persona picker for one persona", () => {
    const html = runNow(
      repo([
        flow({ persona: "bob" }),
        flow({ name: "review", persona: "bob" }),
        flow({ name: "triage", enabled: false }),
      ]),
    );

    expect(html).toContain("Run now");
    expect(html).toContain('<option value="implement"');
    expect(html).toContain('<option value="review"');
    expect(html).not.toContain('<option value="triage"');
    expect(html).toContain('aria-label="item"');
    expect(html).not.toContain('aria-label="persona"');
  });

  test("picks a persona when several run the flow", () => {
    const html = runNow(repo([flow({ persona: "bob" }), flow({ persona: "carol" })]), {
      persona: Option.some("carol"),
    });

    expect(html).toContain('aria-label="persona"');
    expect(html).toContain('<option value="bob">@bob</option>');
    expect(html).toContain('<option value="carol" selected="">@carol</option>');
  });

  test("asks for the item a manual flow needs", () => {
    const html = runNow(repo([flow({ name: "fix", schedule: "manual", manual: true })]), {
      flow: "fix",
    });

    expect(html).toContain('placeholder="item, such as #73 (required)"');
  });

  test("offers nothing for a repo with no flow on", () => {
    expect(runNow(repo([flow({ enabled: false })]))).toBe("");
  });

  test("shows the daemon's refusal beside the button", () => {
    const html = runNow(
      repo([flow({})]),
      {},
      refused("fix needs an item to work on: name it, such as #73"),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("fix needs an item to work on: name it, such as #73");
  });
});

describe("cancel", () => {
  test("asks first, in the page, and offers to close the run's agent sessions", () => {
    expect(cancel(false)).toContain("Cancel");
    expect(cancel(false)).not.toContain("close its agent sessions");

    const asking = cancel(true);

    expect(asking).toContain("Cancel api/implement issue-7?");
    expect(asking).toContain('type="checkbox"');
    expect(asking).toContain("close its agent sessions");
    expect(asking).toContain("Yes, cancel");
    expect(asking).toContain("Keep it");
  });

  test("shows the daemon's refusal beside the button", () => {
    const html = cancel(false, refused("no run in flight matches 5714245a"));

    expect(html).toContain('role="alert"');
    expect(html).toContain("no run in flight matches 5714245a");
  });
});

describe("attach", () => {
  test("copies the command, and opens in the launcher only where it can", () => {
    expect(attach(true)).toContain("Copy attach command");
    expect(attach(true)).toContain("Open in launcher");
    expect(attach(false)).toContain("Copy attach command");
    expect(attach(false)).not.toContain("Open in launcher");
  });

  test("shows the daemon's refusal beside the button", () => {
    const html = attach(true, refused("its session in tmux has ended"));

    expect(html).toContain('role="alert"');
    expect(html).toContain("its session in tmux has ended");
  });

  test("says what it did", () => {
    const html = attach(true, Option.some({ kind: "done", message: "opened in tmux" }));

    expect(html).toContain('role="status"');
    expect(html).toContain("opened in tmux");
  });
});
