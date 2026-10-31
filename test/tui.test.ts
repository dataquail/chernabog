import { HEADLESS, printJson } from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

import {
  type DaemonEvent,
  type DaemonStatus,
  StatusChanged,
} from "../src/interface/daemon/daemon.protocol.ts";
import { initialModel, readUsage } from "../src/interface/tui/app.ts";
import {
  type Feed,
  feed,
  quiet,
  reconnectDelay,
  REFETCH_AT_MOST_EVERY,
  refetched,
} from "../src/interface/tui/live.ts";
import { describeStatus } from "../src/interface/tui/status.ts";
import { type Key, update, type Updated } from "../src/interface/tui/update.ts";
import { type Model, plain, view } from "../src/interface/tui/view.ts";
import { RunId } from "../src/kernel/run-id.id.ts";
import { HoldView } from "../src/modules/runs/domain/holds/hold-view.value-object.ts";
import { RunHistory, RunStep } from "../src/modules/runs/domain/run/run-history.value-object.ts";
import { ActiveRun, RunView } from "../src/modules/runs/domain/run/run-view.value-object.ts";
import { RunWait } from "../src/modules/runs/domain/run-wait/run-wait-view.value-object.ts";
import { SkipView } from "../src/modules/runs/domain/skip/skip-view.value-object.ts";
import { attachCommand } from "../src/modules/runs/infrastructure/runtime/agents.ts";
import {
  LaunchRecord,
  sessionFiles,
} from "../src/modules/runs/infrastructure/runtime/agents/session-files.ts";
import { rememberSession } from "../src/modules/runs/infrastructure/runtime/agents/sessions.ts";
import { execTestLayer } from "../src/platform/exec.ts";
import { Home } from "../src/platform/home.ts";
import { effectAtHome, effectAtHomeWith } from "./effect-test.ts";

const now = DateTime.makeUnsafe("2026-10-17T12:00:00Z");
const minutes = (offset: number) => DateTime.formatIso(DateTime.add(now, { minutes: offset }));

const finishedSummary = (status: RunStatus) => {
  if (status === "done") {
    return "#7: ready for review";
  }

  return "CI still red";
};

type RunStatus = RunView["status"];

const run = (id: string, status: RunStatus) => {
  const running = status === "running";

  return RunView.make({
    id: RunId.make(id),
    repo: "goodbones",
    persona: Option.none(),
    flow: Option.getOrElse(
      Option.as(
        Option.liftPredicate(id, (known) => known.includes("review")),
        "review",
      ),
      () => "implement",
    ),
    // The item its id names, as in goodbones.review.pr-8.1.
    itemKey: Option.getOrElse(
      Option.flatMap(Option.fromNullishOr(/(issue|pr)-\d+/.exec(id)), (match) =>
        Option.fromUndefinedOr(match[0]),
      ),
      () => "issue-7",
    ),
    itemTitle: Option.some("Fix the parser"),
    itemUrl: Option.none(),
    executionId: Option.some("x"),
    status,
    currentStep: Option.as(
      Option.liftPredicate(status, () => running),
      "implement",
    ),
    summary: Option.map(
      Option.liftPredicate(status, () => !running),
      finishedSummary,
    ),
    startedAt: minutes(-30),
    finishedAt: Option.as(
      Option.liftPredicate(status, () => !running),
      minutes(-5),
    ),
  });
};

const status: DaemonStatus = {
  pid: 4242,
  startedAt: minutes(-120),
  busy: 1,
  reloadPending: false,
  repos: [
    {
      name: "goodbones",
      slug: "dataquail/goodbones",
      status: "ready",
      message: Option.none(),
      paused: false,
      enabled: true,
      tree: Option.some("abc"),
      launcher: Option.some("orca (machine config)"),
      flows: [
        {
          name: "implement",
          schedule: "17 * * * *",
          next: Option.some(minutes(17)),
          lastTick: Option.some(minutes(-43)),
          enabled: true,
          queued: ["issue-9 Add a flag"],
        },
        {
          name: "review",
          schedule: "17 * * * *",
          next: Option.some(minutes(17)),
          lastTick: Option.some(minutes(-43)),
          enabled: true,
          queued: [],
        },
      ],
    },
    {
      name: "hexagon",
      slug: "dataquail/hexagon",
      status: "untrusted",
      message: Option.some("not trusted yet; run chernabog trust hexagon"),
      paused: false,
      enabled: true,
      tree: Option.none(),
      launcher: Option.none(),
      flows: [],
    },
  ],
  active: [
    ActiveRun.make({ ...run("goodbones.implement.issue-7.1", "running"), parked: false }),
    ActiveRun.make({ ...run("goodbones.review.pr-8.1", "running"), parked: true }),
  ],
  recent: [
    run("goodbones.implement.issue-7.1", "running"),
    run("goodbones.implement.issue-5.1", "needs-human"),
  ],
  skips: [
    SkipView.make({
      repo: "goodbones",
      persona: Option.none(),
      flow: "implement",
      itemKey: Option.none(),
      reason: "usage gate: five-hour usage 0.5 is at or over the 0.4 ceiling",
      at: minutes(-43),
    }),
  ],
};

const model = (overrides: Partial<Model> = {}): Model => ({
  ...initialModel(140, 40, now),
  status: Option.some(status),
  now,
  ...overrides,
});

describe("the main view", () => {
  const screen = plain(
    view(
      model({
        usage: [
          {
            account: "personal",
            fiveHour: 0.12,
            sevenDay: 0.5,
            launch: true,
            reason: "",
            at: minutes(-43),
          },
        ],
      }),
    ),
  );

  test("shows each repo, its flows, their next tick and their queue", () => {
    expect(screen).toContain("goodbones  ready  launcher orca (machine config)");
    expect(screen).toMatch(/implement\s+next in 17m\s+1 queued: issue-9 Add a flag/);
    expect(screen).toContain("hexagon  untrusted  not trusted yet; run chernabog trust hexagon");
  });

  test("shows account usage against its thresholds", () => {
    expect(screen).toContain(
      "personal    5h  12% of 40%  week  50% of 95%  room for a task (43m ago)",
    );
  });

  test("shows runs in flight with their current step, and waiting ones as waiting", () => {
    expect(screen).toMatch(
      /running\s+#7\s+implement goodbones Fix the parser\s+30m ago\s+implement/,
    );
    expect(screen).toMatch(
      /running\s+PR 8 review\s+goodbones Fix the parser\s+30m ago\s+waiting in implement/,
    );
    expect(screen).toMatch(/needs-human #5\s+implement goodbones .* CI still red/);
  });

  test("names each run's pull request or issue, and gives the title the width it needs", () => {
    const title =
      "feat!: chernabog decides which repos' flows it runs, and state and runs survive an upgrade";

    const items = {
      ...status,
      active: [],
      recent: [
        RunView.make({
          ...run("a", "done"),
          flow: "address-review",
          persona: Option.some("zach"),
          itemKey: "pr-124-changes-1",
          itemTitle: Option.some(title),
        }),
        RunView.make({ ...run("b", "done"), itemKey: "issue-144" }),
        RunView.make({ ...run("c", "done"), itemKey: "chore-sweep", itemTitle: Option.none() }),
      ],
    };

    const rows = plain(view(model({ status: Option.some(items), width: 200 })));
    expect(rows).toContain(`PR 124      address-review goodbones @zach ${title}`);
    expect(rows).toMatch(/done\s+#144\s+implement\s+goodbones\s+Fix the parser/);
    expect(rows).toMatch(/done\s+chore-sweep implement/);

    // On a narrow terminal the title gives way, and the detail keeps some room.
    const narrow = plain(view(model({ status: Option.some(items), width: 120 })));
    expect(narrow).toMatch(/PR 124 .* feat!: chernabog .*…\s+5m ago\s+#7: ready/);
  });

  test("says why ticks were skipped, and fits the terminal", () => {
    expect(screen).toContain("usage gate: five-hour usage 0.5 is at or over the 0.4 ceiling");
    const lines = view(model({ width: 50, height: 12 }));
    expect(lines).toHaveLength(12);
    expect(
      plain(lines)
        .split("\n")
        .every((line) => line.length <= 50),
    ).toBe(true);
  });

  test("says why a flow is off when it isn't simply turned off", () => {
    const notRunner = {
      ...status,
      repos: status.repos.map((repo) => ({
        ...repo,
        flows: repo.flows.map((flow) => ({
          ...flow,
          enabled: false,
          offReason: "not a runner (runners: alice; this machine is bob)",
        })),
      })),
    };

    expect(plain(view(model({ status: Option.some(notRunner) })))).toMatch(
      /implement\s+off\s+not a runner \(runners: alice; this machine is bob\)/,
    );
  });

  test("counts the work it left for other machines", () => {
    const elsewhere = {
      ...status,
      repos: status.repos.map((repo) => ({
        ...repo,
        flows: repo.flows.map((flow) => ({
          ...flow,
          assignedElsewhere: ["issue-4 (alice)", "issue-5 (bob)"],
        })),
      })),
    };

    expect(plain(view(model({ status: Option.some(elsewhere) })))).toMatch(
      /implement\s+next in 17m\s+1 queued: issue-9 Add a flag · 2 left for others/,
    );
  });

  test("without the daemon, it says so", () => {
    expect(
      plain(
        view(
          model({
            status: Option.none(),
            error: Option.some("the daemon is not running. Retrying…"),
          }),
        ),
      ),
    ).toContain("the daemon is not running");
  });

  test("a flow that runs as several personas has a row for each, and the CLI names them", () => {
    const review = Option.getOrThrow(Option.fromUndefinedOr(status.repos[0]?.flows[1]));

    const personas = {
      ...status,
      repos: status.repos.map((repo) => ({
        ...repo,
        flows: [
          { ...review, persona: "alice" },
          { ...review, persona: "bob" },
        ],
      })),
    };

    const rows = plain(view(model({ status: Option.some(personas) })));
    expect(rows).toMatch(/review @alice\s+next in 17m/);
    expect(rows).toMatch(/review @bob\s+next in 17m/);

    const said = describeStatus(personas, now);
    expect(said).toContain("  review as alice: 17 * * * *, next in 17m");
    expect(said).toContain("  review as bob: 17 * * * *, next in 17m");
    expect(describeStatus(status, now)).toContain("  review: 17 * * * *, next in 17m");
  });
});

const held = HoldView.make({
  repo: "goodbones",
  persona: Option.none(),
  flow: "implement",
  itemKey: "issue-14",
  reason: "waits on #12, #13",
  at: minutes(-3),
});

describe("held work", () => {
  test("status lists the items triggers hold, with why, apart from skips", () => {
    const said = describeStatus({ ...status, holds: [held] }, now);
    const holds = said.indexOf("\nheld:");

    expect(holds).toBeGreaterThan(-1);
    expect(said[holds + 1]).toBe("  goodbones/implement #14: waits on #12, #13 (as of 3m ago)");
    expect(said.indexOf("\nrecent skips:")).toBeGreaterThan(holds + 1);
    expect(describeStatus(status, now)).not.toContain("\nheld:");
  });

  test("the live view lists the items triggers hold, with why, apart from skips", () => {
    const screen = plain(view(model({ status: Option.some({ ...status, holds: [held] }) })));

    expect(screen).toContain("Held");
    expect(screen).toContain("implement #14: waits on #12, #13");
    expect(screen.indexOf("Held")).toBeLessThan(screen.indexOf("Recent skips"));
    expect(plain(view(model()))).not.toContain("Held");
  });

  test("the live view says how many more items are held than it shows", () => {
    const holds = [14, 15, 16, 17, 18, 19].map((number) =>
      HoldView.make({ ...held, itemKey: `issue-${number}` }),
    );

    const screen = plain(view(model({ status: Option.some({ ...status, holds }) })));

    expect(screen).toContain("implement #17: waits on #12, #13");
    expect(screen).not.toContain("implement #18");
    expect(screen).toContain("… 2 more (chernabog status lists them all)");
    expect(
      plain(view(model({ status: Option.some({ ...status, holds: holds.slice(0, 4) }) }))),
    ).not.toContain("more (chernabog status");
  });
});

describe("status of runs' work items", () => {
  test("a run whose check keeps failing says so under it, and a superseded run says why", () => {
    const said = describeStatus(
      {
        ...status,
        recent: [
          RunView.make({
            ...run("goodbones.review.pr-6.1", "superseded"),
            summary: Option.some("#6 was closed; interrupted in await-closed:approved"),
          }),
        ],
        validity: [{ runId: "goodbones.review.pr-8.1", failures: 3, problem: "rate limited" }],
      },
      now,
    );

    expect(said).toContain(
      "    stillValid failed 3 time(s) in a row: rate limited (the run carries on)",
    );
    expect(said.some((line) => /^ {2}superseded .*#6 was closed; interrupted in/.test(line))).toBe(
      true,
    );
  });
});

describe("keys", () => {
  test("enter opens the selected run’s detail, l its log, and esc comes back each time", () => {
    const opened = update(model({ runIndex: 1 }), { name: "return" });
    expect(opened.action).toEqual({ kind: "open-run", run: "goodbones.review.pr-8.1" });
    expect(opened.model.view).toBe("run");

    const log = update(opened.model, { name: "l" });
    expect(log.action).toEqual({ kind: "open-log", run: "goodbones.review.pr-8.1" });
    expect(log.model.view).toBe("log");

    const back = update(log.model, { name: "escape" }).model;
    expect(back.view).toBe("run");
    expect(update(back, { name: "escape" }).model.view).toBe("main");
  });

  test("a attaches to the selected run, t triggers the selected flow, p pauses its repo", () => {
    expect(update(model(), { name: "a" }).action).toEqual({
      kind: "attach",
      run: "goodbones.implement.issue-7.1",
    });
    const onFlows = update(model(), { name: "tab" }).model;
    const down = update(onFlows, { name: "down" }).model;
    expect(update(down, { name: "t" }).action).toEqual({
      kind: "trigger",
      repo: "goodbones",
      flow: "review",
      persona: Option.none(),
    });
    expect(update(down, { name: "p" }).action).toEqual({
      kind: "pause",
      repo: "goodbones",
      paused: true,
    });
  });

  test("x asks to cancel the selected run, y cancels it, and any other key keeps it", () => {
    const asked = update(model({ runIndex: 1 }), { name: "x" });

    expect(asked.action).toEqual({ kind: "none" });
    expect(Option.getOrThrow(asked.model.message)).toContain("? It stops for good");

    const confirmed = update(asked.model, { name: "y" });

    expect(confirmed.action).toMatchObject({ kind: "cancel", run: "goodbones.review.pr-8.1" });
    expect(confirmed.model.cancelling).toEqual(Option.none());

    // q while asked keeps the run, rather than quitting.
    const kept = update(asked.model, { name: "q" });

    expect(kept.action).toEqual({ kind: "none" });
    expect(Option.getOrThrow(kept.model.message)).toMatch(/^left .* running$/);
    expect(kept.model.cancelling).toEqual(Option.none());
  });

  test("x on the flows pane cancels nothing", () => {
    const onFlows = update(model(), { name: "tab" }).model;
    const refused = update(onFlows, { name: "x" });

    expect([refused.action, refused.model.cancelling]).toEqual([{ kind: "none" }, Option.none()]);
    expect(refused.model.message).toEqual(Option.some("select a run to cancel (tab to the runs)"));
  });

  test("e turns the selected flow off or on, from what was last turned here until the daemon restarts on it", () => {
    const onFlows = update(model(), { name: "tab" }).model;
    expect(update(onFlows, { name: "e" }).action).toEqual({
      kind: "toggle-flow",
      repo: "goodbones",
      flow: "implement",
      persona: Option.none(),
      enabled: false,
    });
    const pending = { ...onFlows, pendingFlows: { "goodbones/implement": false } };
    expect(update(pending, { name: "e" }).action).toEqual({
      kind: "toggle-flow",
      repo: "goodbones",
      flow: "implement",
      persona: Option.none(),
      enabled: true,
    });
    expect(plain(view(pending))).toMatch(/implement\s+off, pending/);
    expect(update(model(), { name: "e" }).action).toEqual({ kind: "none" });
  });

  test("selection stays within the list", () => {
    let current = model();

    for (let press = 0; press < 10; press++) {
      current = update(current, { name: "down" }).model;
    }

    expect(current.runIndex).toBe(2);
  });

  test("the log follows its end until scrolled, and shows the newest lines that fit", () => {
    const lines = Array.from({ length: 100 }, (_, index) => `line ${index}`);

    const log = model({
      view: "log",
      logRun: Option.some("goodbones.implement.issue-7.1"),
      logLines: lines,
      height: 10,
    });

    expect(plain(view(log))).toContain("line 99");
    const scrolled = update(log, { name: "up" }).model;
    expect(plain(view(scrolled))).not.toContain("line 99");
    expect(plain(view(update(scrolled, { name: "end" }).model))).toContain("line 99");
  });

  test("q quits", () => {
    expect(update(model(), { name: "q" }).action).toEqual({ kind: "quit" });
  });
});

describe("a run's detail", () => {
  const reviewing = ActiveRun.make({
    ...run("r", "running"),
    flow: "address-review",
    persona: Option.some("zach"),
    itemKey: "pr-124-changes-1",
    itemTitle: Option.some("feat!: chernabog decides which repos' flows it runs"),
    itemUrl: Option.some("https://github.com/dataquail/chernabog/pull/124"),
    currentStep: Option.some("consider-review-1"),
    startedAt: minutes(-60),
    parked: true,
  });

  const entered = (step: string, at: number) => RunStep.make({ step, enteredAt: minutes(at) });

  const history = RunHistory.make({
    steps: [
      entered("read-review", -60),
      entered("find-author", -59),
      entered("prepare-worktree", -58),
      entered("comment-pr-124-619c4991c631", -50),
      entered("ci-1", -49),
      entered("ci-1", -45),
      entered("ci-1", -40),
      entered("consider-review-1", -30),
    ],
    waits: [
      RunWait.make({
        runId: RunId.make("r"),
        signal: "pushed",
        deferred: "d",
        token: "t",
        parkedAt: Option.some(minutes(-29)),
      }),
    ],
  });

  const detail = (overrides: Partial<Model> = {}) =>
    model({
      status: Option.some({ ...status, active: [reviewing], recent: [] }),
      view: "run",
      detailRun: Option.some("r"),
      history: Option.some(history),
      worktree: Option.some("/home/zach/.config/chernabog/worktrees/chernabog/auto-issue-123"),
      ...overrides,
    });

  test("shows what the run is about, as whom, and the worktree it uses", () => {
    const screen = plain(view(detail()));
    expect(screen).toContain("goodbones · address-review · @zach");
    expect(screen).toContain(
      "PR 124  feat!: chernabog decides which repos' flows it runs  https://github.com/dataquail/chernabog/pull/124",
    );
    expect(screen).toContain("running  started 1h ago");
    expect(screen).toContain(
      "worktree  /home/zach/.config/chernabog/worktrees/chernabog/auto-issue-123",
    );
  });

  test("shows the steps taken with the time in each, hashes dropped and repeats folded", () => {
    const screen = plain(view(detail()));
    expect(screen).toContain(
      "✓ read-review 1m ─ ✓ find-author 1m ─ ✓ prepare-worktree 8m ─ ✓ comment-pr-124 1m ─ ✓ ci-1 ×3 19m ─ ● consider-review-1 30m",
    );
    expect(screen).not.toContain("619c4991c631");
  });

  test("wraps the path to the terminal's width", () => {
    const lines = plain(view(detail({ width: 60 }))).split("\n");
    const path = lines.filter((line) => line.includes("✓") || line.includes("●"));
    expect(path.length).toBeGreaterThan(1);
    expect(path.every((line) => line.length <= 60)).toBe(true);
    expect(path.join(" ")).toContain("● consider-review-1 30m");
  });

  test("a parked run says which signal it waits on, since which step, and for how long", () => {
    expect(plain(view(detail()))).toContain("for pushed since consider-review-1, for 29m");
    expect(
      plain(view(model({ status: Option.some({ ...status, active: [reviewing] }), width: 200 }))),
    ).toContain("waiting in consider-review-1");
  });

  test("a finished run's last step shows how it ended, and the time up to its end", () => {
    const failed = ActiveRun.make({
      ...reviewing,
      status: "failed",
      parked: false,
      finishedAt: Option.some(minutes(-20)),
      summary: Option.some("CI still red"),
    });

    const screen = plain(
      view(detail({ status: Option.some({ ...status, active: [failed], recent: [] }) })),
    );

    expect(screen).toContain("✗ consider-review-1 10m");
    expect(screen).toContain("· finished 20m ago  CI still red");
    expect(screen).not.toContain("for pushed");
  });

  test("a run from before steps were kept says so, rather than guessing", () => {
    const old = RunHistory.make({ steps: [], waits: [] });
    expect(plain(view(detail({ history: Option.some(old), worktree: Option.none() })))).toContain(
      "no steps recorded: this run started before chernabog kept them",
    );
    expect(plain(view(detail({ worktree: Option.none() })))).toContain(
      "worktree  none yet: no agent session has started",
    );
  });

  test("a attaches, x asks to cancel, and the keys say what they do", () => {
    expect(update(detail(), { name: "a" }).action).toEqual({ kind: "attach", run: "r" });

    const asked = update(detail(), { name: "x" }).model;
    expect(Option.getOrThrow(asked.message)).toContain("? It stops for good");
    expect(update(asked, { name: "y" }).action).toMatchObject({ kind: "cancel", run: "r" });
    expect(plain(view(detail()))).toContain("l log · a attach · x cancel run · esc back");
  });
});

describe("work threads", () => {
  const at = (
    id: string,
    flow: string,
    itemKey: string,
    ended: RunStatus,
    fields: Partial<RunView> = {},
  ) => RunView.make({ ...run(id, ended), flow, itemKey, ...fields });

  const rereview = ActiveRun.make({
    ...at("t4", "re-review", "pr-124-review-2", "running"),
    parked: false,
  });

  const thread: DaemonStatus = {
    ...status,
    active: [rereview],
    recent: [
      at("t3", "address-review", "pr-124-changes-1", "done"),
      at("other", "review", "pr-200", "done"),
      at("t2", "review", "pr-124", "done"),
      at("t1", "human-initiated", "issue-123", "done", { subjects: ["pr-124"] }),
      at("t0", "implement", "issue-123", "needs-human"),
    ],
  };

  const opened = model({ status: Option.some(thread), width: 160 });
  const rows = (from: Model) => plain(view(from)).split("\n");

  test("an issue, the pull request it opened, and that pull request's runs are one row", () => {
    const runs = rows(opened).filter((line) => / (running|done|needs-human) /.test(line));
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatch(/▸ running\s+PR 124 re-review \+4/);
    expect(runs[1]).toMatch(/^\s+done\s+PR 200 review/);
  });

  test("space opens a thread under its latest run, and closes it from any of its runs", () => {
    const open = update(opened, { name: "space" }).model;
    const screen = plain(view(open));
    expect(screen).toMatch(/▾ running\s+PR 124 re-review\s/);
    expect(screen).toMatch(/└ done\s+PR 124 address-review/);
    expect(screen).toMatch(/└ done\s+#123\s+human-initiated/);
    expect(screen).toMatch(/└ needs-human #123\s+implement/);

    const onOld = update(update(open, { name: "down" }).model, { name: "down" }).model;
    expect(update(onOld, { name: "a" }).action).toEqual({ kind: "attach", run: "t2" });

    const closed = update(onOld, { name: "space" }).model;
    expect(closed.expanded).toEqual([]);
    expect(closed.runIndex).toBe(0);
  });

  test("a run's detail lists the other runs of its thread, and enter opens one", () => {
    const detail = update(opened, { name: "return" }).model;
    const screen = plain(view(detail));
    expect(screen).toContain("Thread");
    expect(screen).toMatch(/done\s+PR 124 address-review/);
    expect(screen).toMatch(/needs-human #123 implement/);
    expect(screen).not.toContain("PR 200");

    const second = update(update(detail, { name: "down" }).model, { name: "return" });
    expect(second.action).toEqual({ kind: "open-run", run: "t2" });
    expect(second.model.threadIndex).toBe(0);
  });

  const leads = (from: DaemonStatus) =>
    rows(model({ status: Option.some(from), width: 160 })).filter((line) =>
      / (running|done|needs-human) /.test(line),
    );

  test("a run that opened two pull requests threads with the runs on both", () => {
    const epic: DaemonStatus = {
      ...status,
      active: [],
      recent: [
        at("e3", "review", "pr-41", "done"),
        at("e2", "review", "pr-40", "done"),
        at("e1", "epic", "epic-7", "done", { subjects: ["pr-40", "pr-41"] }),
        at("e0", "review", "pr-99", "done"),
      ],
    };

    const shown = leads(epic);
    expect(shown).toHaveLength(2);
    expect(shown[0]).toMatch(/PR 41 review \+2/);
    expect(shown[1]).toMatch(/PR 99 review/);
  });

  test("a run that opened no pull request but cut a release threads with the release's runs", () => {
    const release: DaemonStatus = {
      ...status,
      active: [],
      recent: [
        at("l2", "announce", "release-1.4", "done"),
        at("l1", "cut-release", "nightly-1", "done", { subjects: ["release-1.4"] }),
        at("l0", "cut-release", "nightly-0", "done"),
      ],
    };

    const shown = leads(release);
    expect(shown).toHaveLength(2);
    expect(shown[0]).toMatch(/announce\s+\+1/);
    expect(shown[1]).toMatch(/nightly-0/);
  });
});

describe("project tabs and the persona filter", () => {
  const goodbones = Option.getOrThrow(Option.fromUndefinedOr(status.repos[0]));
  const review = Option.getOrThrow(Option.fromUndefinedOr(goodbones.flows[1]));

  const as = (id: string, repo: string, persona: string, itemKey: string) =>
    ActiveRun.make({
      ...run(id, "running"),
      repo,
      flow: "review",
      persona: Option.some(persona),
      itemKey,
      parked: false,
    });

  const two: DaemonStatus = {
    ...status,
    repos: [
      {
        ...goodbones,
        flows: [
          { ...review, persona: "alice" },
          { ...review, persona: "bob" },
        ],
      },
      {
        ...goodbones,
        name: "chernabog",
        slug: "dataquail/chernabog",
        flows: [{ ...review, persona: "alice" }],
      },
    ],
    active: [
      as("r1", "goodbones", "alice", "pr-1"),
      as("r2", "goodbones", "bob", "pr-2"),
      as("r3", "chernabog", "alice", "pr-3"),
    ],
    recent: [],
    skips: [
      SkipView.make({
        repo: "chernabog",
        persona: Option.some("alice"),
        flow: "review",
        itemKey: Option.none(),
        reason: "nothing to review",
        at: minutes(-1),
      }),
    ],
  };

  const opened = model({ status: Option.some(two) });

  const press = (from: Model, ...keys: ReadonlyArray<string>) =>
    keys.reduce((current, name) => update(current, { name, sequence: name }).model, from);

  test("shows a tab per project and the persona filter, both at All to begin with", () => {
    const screen = plain(view(opened));
    expect(screen).toContain(" All · goodbones · chernabog    persona all");
    expect(screen).toMatch(/PR 1\s+review goodbones @alice/);
    expect(screen).toContain("review @bob");
  });

  test("a project tab shows only its repo's flows, runs and skips, and drops the repo column", () => {
    const chernabog = press(opened, "2");
    expect(chernabog.project).toEqual(Option.some("chernabog"));

    const screen = plain(view(chernabog));
    expect(screen).not.toContain("goodbones  ready");
    expect(screen).toMatch(/PR 3\s+review @alice/);
    expect(screen).not.toContain("PR 1");
    expect(screen).toContain("nothing to review");

    expect(press(chernabog, "0").project).toEqual(Option.none());
    expect(press(opened, "]").project).toEqual(Option.some("goodbones"));
    expect(press(opened, "[").project).toEqual(Option.some("chernabog"));
    expect(press(opened, "]", "]", "]").project).toEqual(Option.none());
    // There is no ninth project.
    expect(press(chernabog, "9").project).toEqual(Option.some("chernabog"));
  });

  test("@ cycles the persona filter, which drops the persona column", () => {
    const bob = press(opened, "@", "@");
    expect(bob.personaFilter).toEqual(Option.some(Option.some("bob")));

    const screen = plain(view(bob));
    expect(screen).toContain("persona @bob");
    expect(screen).toMatch(/PR 2\s+review goodbones Fix the parser/);
    expect(screen).not.toContain("PR 1");
    expect(screen).not.toContain("nothing to review");

    expect(press(bob, "@").personaFilter).toEqual(Option.none());
  });

  test("keys act on the rows shown, and a filter starts the selection at the top", () => {
    const down = press(opened, "down", "down");
    expect(down.runIndex).toBe(2);

    const chernabog = press(down, "2");
    expect(chernabog.runIndex).toBe(0);
    expect(update(chernabog, { name: "a" }).action).toEqual({ kind: "attach", run: "r3" });

    const onFlows = press(press(opened, "@", "@"), "tab");
    expect(update(onFlows, { name: "t" }).action).toEqual({
      kind: "trigger",
      repo: "goodbones",
      flow: "review",
      persona: Option.some("bob"),
    });
  });

  test("with one project and one persona there is nothing to choose, so neither shows", () => {
    const one = { ...status, repos: [goodbones] };
    const screen = plain(view(model({ status: Option.some(one) })));
    expect(screen).not.toContain(" All ");
    expect(screen).not.toContain("persona all");
    expect(screen).toMatch(/#7\s+implement Fix the parser/);
    expect(press(model({ status: Option.some(one) }), "1").project).toEqual(Option.none());
  });
});

const window = (utilization: number) => ({ utilization, resets_at: minutes(600) });

effectAtHome("usage comes from the latest line of each account's usage log", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { root } = yield* Home;

    const lines = [
      printJson({
        at: minutes(-90),
        five_hour: window(1),
        seven_day: window(2),
        launch: true,
        reason: "old",
      }),
      printJson({
        at: minutes(-30),
        five_hour: window(45),
        seven_day: window(60),
        launch: false,
        reason: "five-hour usage high",
      }),
    ];

    yield* fs.writeFileString(`${root}/usage-personal.jsonl`, lines.join("\n"));
    expect(yield* readUsage).toEqual([
      {
        account: "personal",
        fiveHour: 0.45,
        sevenDay: 0.6,
        launch: false,
        reason: "five-hour usage high",
        at: minutes(-30),
      },
    ]);
  }),
);

// tmux answers has-session for the sessions in `tmuxSessions`.
const tmuxSessions = new Set<string>();

const effectWithTmux = effectAtHomeWith(
  execTestLayer((command, args) =>
    Option.some({
      exitCode: Number(!(command === "tmux" && tmuxSessions.has(args.at(-1) ?? ""))),
      stdout: "",
      stderr: "",
    }),
  ),
);

const account = {
  name: "personal",
  configDir: Option.some("/Users/dev/.claude-personal"),
  expectedEmail: Option.none<string>(),
  oauthTokenEnv: Option.none<string>(),
  usageGate: "usage" as const,
};

effectWithTmux(
  "attach opens each agent's own interactive UI on the run's session, in its worktree",
  () =>
    Effect.gen(function* () {
      const at = DateTime.formatIso(now);

      const claude = yield* attachCommand({
        adapter: "claude",
        sessionId: "abc",
        cwd: "/wt",
        account,
        at,
      });

      yield* rememberSession("codex", "abc", "thread-1");

      const codex = yield* attachCommand({
        adapter: "codex",
        sessionId: "abc",
        cwd: "/wt",
        account: { ...account, configDir: Option.some("/Users/dev/.codex") },
        at,
      });

      expect([claude.command, ...claude.args]).toEqual(["claude", "--resume", "abc"]);
      expect(Record.get(claude.env, "CLAUDE_CONFIG_DIR")).toEqual(
        Option.some("/Users/dev/.claude-personal"),
      );
      expect([codex.command, ...codex.args]).toEqual(["codex", "resume", "thread-1"]);
      expect(Record.get(codex.env, "CODEX_HOME")).toEqual(Option.some("/Users/dev/.codex"));
    }),
);

effectWithTmux(
  "attach brings up a session still running under tmux, and resumes it once it has ended",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const files = sessionFiles((yield* Home).root, "abc");
      const at = DateTime.formatIso(now);
      yield* fs.makeDirectory(files.dir, { recursive: true });
      yield* fs.writeFileString(
        files.launch,
        yield* Schema.encodeEffect(LaunchRecord)({
          launcher: { ...HEADLESS, name: "tmux", from: "machine config" },
          handle: "chernabog-abc",
          at,
        }),
      );
      const record = { adapter: "claude", sessionId: "abc", cwd: "/wt", account, at };
      tmuxSessions.add("=chernabog-abc");
      const live = yield* attachCommand(record);
      tmuxSessions.clear();
      const ended = yield* attachCommand(record);
      expect([live.command, ...live.args]).toEqual([
        "tmux",
        "attach-session",
        "-t",
        "=chernabog-abc",
      ]);
      expect([ended.command, ...ended.args]).toEqual(["claude", "--resume", "abc"]);
    }),
);

describe("the settings view", () => {
  const withOverrides: DaemonStatus = {
    ...status,
    accounts: [
      { name: "work", agent: "claude" },
      { name: "codex-work", agent: "codex" },
    ],
    repos: status.repos.map((repo) => ({
      ...repo,
      flows: repo.flows.map((flow) => ({
        ...flow,
        teamSchedule: "17 * * * *",
        ...Option.match(
          Option.liftPredicate(flow.name, (name) => name === "review"),
          {
            onNone: () => ({}),
            onSome: () => ({ ownSchedule: "5 * * * *", schedule: "5 * * * *" }),
          },
        ),
      })),
      personas: [
        {
          account: "work",
          ownAccount: Option.none(),
          roles: [{ role: "reviewer", account: Option.some("codex-work") }],
        },
      ],
    })),
  };

  // Enter on the first flow opens its persona's settings.
  const opened = () => {
    const onFlows = update(model({ status: Option.some(withOverrides) }), { name: "tab" }).model;

    return update(onFlows, { name: "return" }).model;
  };

  const press = (from: Model, ...keys: ReadonlyArray<Key>) =>
    keys.reduce((state: Updated, key) => update(state.model, key), {
      model: from,
      action: { kind: "none" },
    });

  test("shows each flow's schedule next to the team's, and the accounts with what's yours", () => {
    const screen = plain(view(opened()));
    expect(screen).toMatch(/implement\s+on\s+17 \* \* \* \*\s+team's/);
    expect(screen).toMatch(/review\s+on\s+5 \* \* \* \*\s+yours; team's 17 \* \* \* \*/);
    expect(screen).toMatch(/account\s+work \(default\)/);
    expect(screen).toMatch(/role reviewer\s+codex-work \(yours\)/);
  });

  test("a schedule is checked before it is saved, and an invalid one is refused with the reason", () => {
    const typed = press(
      opened(),
      { name: "s" },
      ...[..."*/20 * * *"].map((sequence) => ({ name: sequence, sequence })),
      { name: "return" },
    );

    expect(typed.action).toEqual({ kind: "none" });
    expect(Option.getOrElse(typed.model.message, () => "")).toContain(
      '"*/20 * * *" isn\'t a schedule',
    );

    const fixed = press(
      typed.model,
      { name: "space", sequence: " " },
      { name: "*", sequence: "*" },
      { name: "return" },
    );

    expect(fixed.action).toEqual({
      kind: "set-schedule",
      repo: "goodbones",
      flow: "implement",
      persona: Option.none(),
      schedule: Option.some("*/20 * * * *"),
    });
  });

  test("q types into a schedule instead of quitting, and esc cancels it", () => {
    const typing = press(opened(), { name: "s" }, { name: "q", sequence: "q" });
    expect(typing.action).toEqual({ kind: "none" });
    expect(
      press(typing.model, { name: "escape" }).model.settings.pipe(
        Option.map((found) => found.editing.kind),
      ),
    ).toEqual(Option.some("browse"));
  });

  test("c clears an override back to the team's, and says when there's none to clear", () => {
    expect(press(opened(), { name: "j" }, { name: "c" }).action).toEqual({
      kind: "set-schedule",
      repo: "goodbones",
      flow: "review",
      persona: Option.none(),
      schedule: Option.none(),
    });
    const none = press(opened(), { name: "c" });
    expect(none.action).toEqual({ kind: "none" });
    expect(Option.getOrElse(none.model.message, () => "")).toContain("nothing of yours to clear");
    expect(
      press(opened(), { name: "j" }, { name: "j" }, { name: "j" }, { name: "c" }).action,
    ).toEqual({
      kind: "set-account",
      repo: "goodbones",
      persona: Option.none(),
      role: Option.some("reviewer"),
      account: Option.none(),
    });
  });

  test("picks the account for the persona, or for a role", () => {
    expect(
      press(
        opened(),
        { name: "j" },
        { name: "j" },
        { name: "return" },
        { name: "j" },
        { name: "return" },
      ).action,
    ).toEqual({
      kind: "set-account",
      repo: "goodbones",
      persona: Option.none(),
      role: Option.none(),
      account: Option.some("codex-work"),
    });
    expect(
      press(
        opened(),
        { name: "j" },
        { name: "j" },
        { name: "j" },
        { name: "return" },
        { name: "return" },
      ).action,
    ).toEqual({
      kind: "set-account",
      repo: "goodbones",
      persona: Option.none(),
      role: Option.some("reviewer"),
      account: Option.some("work"),
    });
  });

  test("e turns the selected flow off, and esc goes back to the main view", () => {
    expect(press(opened(), { name: "e" }).action).toEqual({
      kind: "toggle-flow",
      repo: "goodbones",
      flow: "implement",
      persona: Option.none(),
      enabled: false,
    });
    expect(press(opened(), { name: "escape" }).model.view).toBe("main");
  });
});

describe("the live view's updates from /events", () => {
  const changed = (eventId: string): DaemonEvent =>
    StatusChanged.make({ eventId, files: ["config.yaml"], at: minutes(0) });

  // How many refetches a run of feed messages asks for.
  const refetchesFor = (messages: ReadonlyArray<Feed>) =>
    messages.reduce(
      (fed, message) => {
        const next = feed(fed.model, fed.live, message);

        return { ...next, asked: fed.asked + Number(Option.isSome(next.refetchIn)) };
      },
      { model: model(), live: quiet, asked: 0 },
    ).asked;

  test("a snapshot replaces the model's status, and says it is connected again", () => {
    const dropped = feed(
      model({ status: Option.none(), error: Option.some("the daemon is not answering") }),
      quiet,
      { kind: "dropped", reason: "the daemon is not answering" },
    );

    expect(dropped.model.reconnecting).toBe(true);

    const fed = feed(dropped.model, dropped.live, { kind: "snapshot", status });

    expect(fed.model.status).toEqual(Option.some(status));
    expect(fed.model.error).toEqual(Option.none());
    expect(fed.model.reconnecting).toBe(false);
    expect(fed.refetchIn).toEqual(Option.none());
  });

  test("a snapshot from a restarted daemon forgets the flows turned on or off here", () => {
    const pending = model({ pendingFlows: { "goodbones/implement": false } });

    const same = feed(pending, quiet, { kind: "snapshot", status });

    expect(same.model.pendingFlows).toEqual({ "goodbones/implement": false });

    const restarted = feed(pending, quiet, {
      kind: "snapshot",
      status: { ...status, pid: status.pid + 1 },
    });

    expect(restarted.model.pendingFlows).toEqual({});
  });

  test("an event asks for /status once, within 250 ms", () => {
    const fed = feed(model(), quiet, { kind: "event", event: changed("a") });

    expect(fed.refetchIn).toEqual(Option.some(REFETCH_AT_MOST_EVERY));
    expect(Duration.toMillis(REFETCH_AT_MOST_EVERY)).toBe(250);
    expect(refetchesFor([{ kind: "event", event: changed("a") }])).toBe(1);
  });

  test("a burst of events asks for /status once", () => {
    expect(
      refetchesFor(["a", "b", "c", "d", "e"].map((id) => ({ kind: "event", event: changed(id) }))),
    ).toBe(1);
  });

  test("an event after the refetch ran asks again", () => {
    const first = feed(model(), quiet, { kind: "event", event: changed("a") });
    const again = feed(first.model, refetched(first.live), { kind: "event", event: changed("b") });

    expect(Option.isSome(again.refetchIn)).toBe(true);
  });

  test("a dropped stream says reconnecting in the header and keeps what it last knew", () => {
    const fed = feed(model(), quiet, { kind: "dropped", reason: "the daemon is not answering" });

    expect(fed.model.status).toEqual(Option.some(status));
    expect(plain(view(fed.model)).split("\n")[0]).toContain("reconnecting");
    expect(plain(view(model())).split("\n")[0]).not.toContain("reconnecting");
  });

  test("reconnects after 1, 2 and 4 seconds, then every 5", () => {
    expect(
      [0, 1, 2, 3, 4, 10].map((attempt) => Duration.toSeconds(reconnectDelay(attempt))),
    ).toEqual([1, 2, 4, 5, 5, 5]);
  });
});
