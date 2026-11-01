// The overview, rendered against canned statuses as the daemon sends them.

import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import { renderToStaticMarkup } from "react-dom/server";

import { DaemonStatus, type RepoStatus } from "#daemon/protocol";

import { everything, type Filter, filtered, personaChoices, repoChoices } from "./filter.ts";
import { onKey, runOrder } from "./keys.ts";
import { type Connection, initial, type Live } from "./live.ts";
import { Overview } from "./overview.tsx";

// The schemas of what /status carries, from the protocol, so the canned
// statuses are built as the daemon builds them.
const ActiveRun = DaemonStatus.fields.active.value;
const RunView = DaemonStatus.fields.recent.value;
const SkipView = DaemonStatus.fields.skips.value;
const HoldView = DaemonStatus.fields.holds.schema.value;
const RunMarkerView = DaemonStatus.fields.markers.schema.value;
const RunId = RunView.fields.id;

type RunFields = Partial<Omit<typeof RunView.Type, "id">>;

type FlowFields = Partial<RepoStatus["flows"][number]>;

const NOW = Date.parse("2026-10-31T12:00:00.000Z");

const runFields = (id: string, fields: RunFields) => ({
  id: RunId.make(id),
  repo: "api",
  persona: Option.none(),
  flow: "implement",
  itemKey: "issue-7",
  itemTitle: Option.some("Fix the parser"),
  itemUrl: Option.none(),
  executionId: Option.none(),
  subjects: [],
  status: "running" as const,
  currentStep: Option.none(),
  summary: Option.none(),
  configTree: Option.none(),
  startedAt: "2026-10-31T11:55:00.000Z",
  finishedAt: Option.none(),
  ...fields,
});

const active = (id: string, fields: RunFields, parked = false) =>
  ActiveRun.make({ ...runFields(id, fields), parked });

const ended = (id: string, fields: RunFields) => RunView.make(runFields(id, fields));

const flow = (fields: FlowFields): RepoStatus["flows"][number] => ({
  name: "implement",
  schedule: "*/5 * * * *",
  next: Option.none(),
  lastTick: Option.none(),
  enabled: true,
  queued: [],
  ...fields,
});

const repo = (name: string, fields: Partial<RepoStatus>): RepoStatus => ({
  name,
  slug: `acme/${name}`,
  status: "ready",
  message: Option.none(),
  paused: false,
  enabled: true,
  tree: Option.none(),
  launcher: Option.none(),
  flows: [],
  ...fields,
});

const empty: DaemonStatus = {
  pid: 4242,
  startedAt: "2026-10-31T09:00:00.000Z",
  busy: 0,
  reloadPending: false,
  repos: [],
  active: [],
  recent: [],
  skips: [],
};

// Two repos, one of them paused, with flows that show every field, a run in
// flight in each and two that ended.
const busy: DaemonStatus = {
  ...empty,
  busy: 2,
  repos: [
    repo("api", {
      launcher: Option.some("orca (machine config)"),
      personas: [
        { persona: "bob", account: "work", ownAccount: Option.none(), roles: [] },
        { account: "default", ownAccount: Option.none(), roles: [] },
      ],
      flows: [
        flow({
          persona: "bob",
          schedule: "*/10 * * * *",
          teamSchedule: "*/5 * * * *",
          ownSchedule: "*/10 * * * *",
          next: Option.some("2026-10-31T12:10:00.000Z"),
          lastTick: Option.some("2026-10-31T11:50:00.000Z"),
          lastCause: "local: #73 review requested",
          pending: "notification: review_requested on #74",
          queued: ["issue-8", "issue-9"],
          assignedElsewhere: ["issue-10 (assigned to alice)"],
          source: "@acme/recipes@2.1.0",
        }),
        flow({ name: "review", enabled: false, offReason: "turned off on this machine" }),
      ],
    }),
    repo("web", { paused: true, flows: [flow({ persona: "carol" })] }),
  ],
  active: [
    active("run-api", { persona: Option.some("bob"), currentStep: Option.some("implement") }),
    active(
      "run-web",
      {
        repo: "web",
        persona: Option.some("carol"),
        itemKey: "pr-3",
        startedAt: "2026-10-31T10:30:00.000Z",
      },
      true,
    ),
  ],
  recent: [
    ended("run-done", {
      status: "done",
      summary: Option.some("Opened #80"),
      finishedAt: Option.some("2026-10-31T11:40:00.000Z"),
    }),
    ended("run-failed", {
      repo: "web",
      status: "failed",
      summary: Option.some("the tests failed"),
      finishedAt: Option.some("2026-10-31T11:00:00.000Z"),
    }),
  ],
};

// One of each thing the attention panel shows.
const troubled: DaemonStatus = {
  ...empty,
  active: [active("run-api", {})],
  skips: [
    SkipView.make({
      repo: "api",
      persona: Option.none(),
      flow: "implement",
      itemKey: Option.some("issue-7"),
      reason: "no free slot",
      at: "2026-10-31T11:59:00.000Z",
    }),
  ],
  holds: [
    HoldView.make({
      repo: "api",
      persona: Option.none(),
      flow: "merge",
      itemKey: "pr-4",
      reason: "CI is red",
      at: "2026-10-31T11:58:00.000Z",
    }),
  ],
  markers: [
    RunMarkerView.make({
      runId: RunId.make("run-old"),
      name: "label",
      args: { label: "in-progress" },
      keepOn: [],
      status: "unreleasable",
      heldAt: "2026-10-30T11:00:00.000Z",
      attempts: 3,
      lastError: Option.some("no flow releases label"),
      nextAttemptAt: Option.none(),
    }),
  ],
  validity: [{ runId: "run-api", failures: 4, problem: "the issue was closed" }],
  leases: [
    {
      runId: "run-api",
      item: "issue-7",
      expiresAt: Option.some("2026-10-31T12:05:00.000Z"),
      renewedAt: Option.some("2026-10-31T11:50:00.000Z"),
      atRisk: Option.some("GitHub answered 502"),
    },
    {
      runId: "run-api",
      item: "issue-8",
      expiresAt: Option.some("2026-10-31T12:05:00.000Z"),
      renewedAt: Option.some("2026-10-31T11:59:00.000Z"),
      atRisk: Option.none(),
    },
  ],
  notifications: [
    {
      persona: "bob",
      problem: Option.some("the token lacks the notifications scope: run gh auth refresh"),
    },
    { persona: "carol", problem: Option.none() },
  ],
};

const shown = (status: DaemonStatus, connection: Connection = { kind: "live" }): Live => ({
  ...initial,
  connection,
  status: Option.some(status),
});

const render = (
  live: Live,
  filter: Filter = everything,
  selected: Option.Option<number> = Option.none(),
) =>
  renderToStaticMarkup(
    <Overview live={live} filter={filter} selected={selected} now={NOW} onFilter={() => {}} />,
  );

describe("the overview", () => {
  test("of a daemon with nothing enrolled says so, and has no attention panel", () => {
    const page = render(shown(empty));

    expect(page).toContain("<dt>pid</dt><dd>4242</dd>");
    expect(page).toContain("No repos are enrolled");
    expect(page).toContain("No runs in flight");
    expect(page).not.toContain('aria-label="Attention"');
  });

  test("shows each kind of attention, once, in one panel", () => {
    const page = render(shown(troubled));

    expect(page).toContain('aria-label="Attention"');

    for (const [kind, says] of [
      ["skip", "no free slot"],
      ["hold", "CI is red"],
      ["marker", "no flow releases label"],
      ["validity", "the issue was closed"],
      ["lease", "GitHub answered 502"],
      ["notification", "the token lacks the notifications scope"],
    ]) {
      expect(page).toContain(`data-kind="${kind}"`);
      expect(page).toContain(says);
    }

    // The lease that renewed and carol's working poll need no one.
    expect(page.match(/data-kind="lease"/g)).toHaveLength(1);
    expect(page.match(/data-kind="notification"/g)).toHaveLength(1);
  });

  test("shows a draining daemon, busy, in the header", () => {
    const page = render(shown({ ...empty, busy: 3, draining: true }));

    expect(page).toContain("<dt>busy</dt><dd>3</dd>");
    expect(page).toContain("draining");
    expect(page).not.toContain("reload pending");
  });

  test("shows a pending reload in the header", () => {
    const page = render(shown({ ...empty, reloadPending: true }));

    expect(page).toContain("reload pending");
  });

  test("shows each repo with its status, launcher, personas and flows", () => {
    const page = render(shown(busy));

    expect(page).toContain("acme/api");
    expect(page).toContain("orca (machine config)");
    expect(page).toContain("bob");
    expect(page).toContain("paused");

    for (const says of [
      "*/5 * * * *",
      "*/10 * * * *",
      "local: #73 review requested",
      "notification: review_requested on #74",
      "issue-8",
      "issue-9",
      "issue-10 (assigned to alice)",
      "turned off on this machine",
      "@acme/recipes@2.1.0",
      'dateTime="2026-10-31T12:10:00.000Z"',
      'dateTime="2026-10-31T11:50:00.000Z"',
    ]) {
      expect(page).toContain(says);
    }
  });

  test("shows active runs with how long they've run, and recent ones with how they ended, each linking to its detail", () => {
    const page = render(shown(busy));

    expect(page).toContain('href="#/runs/run-api"');
    expect(page).toContain('href="#/runs/run-done"');
    expect(page).toContain("5m 00s");
    expect(page).toContain("1h 30m");
    expect(page).toContain("Fix the parser");
    expect(page).toContain("implement");
    expect(page).toContain("Opened #80");
    expect(page).toContain("the tests failed");
    expect(page).toContain('dateTime="2026-10-31T11:40:00.000Z"');
  });

  test("marks the run the keyboard selected", () => {
    const page = render(shown(busy), everything, Option.some(2));

    expect(page.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(page).toMatch(/aria-selected="true"[^>]*>(?:(?!<\/tr>).)*run-done/);
  });

  test("says when it's reconnecting, and keeps what it showed", () => {
    const page = render(shown(busy, { kind: "reconnecting", reason: "the stream dropped" }));

    expect(page).toContain("Reconnecting");
    expect(page).toContain("acme/api");
  });

  test("says when the dashboard was stopped", () => {
    const page = render(shown(busy, { kind: "stopped" }));

    expect(page).toContain(
      "the dashboard was stopped; run <code>chernabog ui</code> to start it again",
    );
  });

  test("says why the daemon refused it", () => {
    const page = render({
      ...initial,
      connection: {
        kind: "refused",
        message: "open the dashboard from the URL chernabog ui prints",
      },
    });

    expect(page).toContain("open the dashboard from the URL chernabog ui prints");
  });
});

describe("filtering by repo and persona", () => {
  test("offers each repo and persona the status names", () => {
    expect(repoChoices(busy)).toEqual(["api", "web"]);
    expect(personaChoices(busy)).toEqual(["bob", "carol"]);
  });

  test("keeps one repo's flows and runs", () => {
    const kept = filtered(busy, { ...everything, repo: Option.some("web") });

    expect(kept.repos.map((one) => one.name)).toEqual(["web"]);
    expect(kept.active.map((one) => String(one.id))).toEqual(["run-web"]);
    expect(kept.recent.map((one) => String(one.id))).toEqual(["run-failed"]);
  });

  test("keeps one persona's flows and runs, and the repos they're in", () => {
    const kept = filtered(busy, { ...everything, persona: Option.some("bob") });

    expect(kept.repos.map((one) => one.name)).toEqual(["api"]);
    expect(kept.repos.flatMap((one) => one.flows.map((each) => each.name))).toEqual(["implement"]);
    expect(kept.active.map((one) => String(one.id))).toEqual(["run-api"]);
    expect(kept.recent).toEqual([]);
  });

  test("keeps the attention a repo or persona names", () => {
    expect(filtered(troubled, { ...everything, repo: Option.some("web") }).skips).toEqual([]);
    expect(
      filtered(troubled, { ...everything, persona: Option.some("carol") }).notifications,
    ).toEqual([{ persona: "carol", problem: Option.none() }]);
  });
});

describe("the keyboard", () => {
  const runs = runOrder(busy);

  test("orders active runs before recent ones", () => {
    expect(runs).toEqual(["run-api", "run-web", "run-done", "run-failed"]);
  });

  test("j and k move through the runs, and stop at either end", () => {
    expect(onKey("j", runs, Option.none())).toEqual({ kind: "select", index: 0 });
    expect(onKey("j", runs, Option.some(0))).toEqual({ kind: "select", index: 1 });
    expect(onKey("j", runs, Option.some(3))).toEqual({ kind: "select", index: 3 });
    expect(onKey("k", runs, Option.some(2))).toEqual({ kind: "select", index: 1 });
    expect(onKey("k", runs, Option.some(0))).toEqual({ kind: "select", index: 0 });
    expect(onKey("j", [], Option.none())).toEqual({ kind: "none" });
  });

  test("enter opens the selected run, and / focuses the filter", () => {
    expect(onKey("Enter", runs, Option.some(2))).toEqual({ kind: "open", runId: "run-done" });
    expect(onKey("Enter", runs, Option.none())).toEqual({ kind: "none" });
    expect(onKey("/", runs, Option.none())).toEqual({ kind: "focus-filter" });
    expect(onKey("x", runs, Option.none())).toEqual({ kind: "none" });
  });
});
