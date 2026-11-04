// A run's detail: what the page loads for it, when it loads it again, its
// log as GET /api/runs/:id/log streams it, and the page rendered against a
// finished run, a parked run and an id the daemon has no run for.

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { it } from "effect-bun-test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DaemonStatus,
  RunEnteredStep,
  RunFinished,
  RunFinishedStep,
  RunHistory,
  RunNeedsAttention,
  RunReply,
  StatusChanged,
} from "#daemon/protocol";

import type { Heard } from "./feed.ts";
import { type Detail, loadDetail, refetchesFor } from "./run.ts";
import { githubUrl, RunDetailView, stepLogMode } from "./run-detail.tsx";
import {
  appended,
  hearLog,
  initialLog,
  linesOfStep,
  type LogHeard,
  type LogState,
  MAX_LOG_LINES,
  runLogFeed,
} from "./run-log.ts";

const RunView = DaemonStatus.fields.recent.value;
const RunId = RunView.fields.id;
const RunStep = RunHistory.fields.steps.value;
const RunWait = RunHistory.fields.waits.value;

const ID = "5714245a-211c-4f0d-8ce1-74b725bac0d6";
const NOW = Date.parse("2026-10-31T12:00:00.000Z");

type RunFields = Partial<Omit<typeof RunView.Type, "id">>;

const run = (fields: RunFields) =>
  RunView.make({
    id: RunId.make(ID),
    repo: "api",
    persona: Option.some("bob"),
    flow: "implement",
    itemKey: "issue-7",
    itemTitle: Option.some("Fix the parser"),
    itemUrl: Option.some("https://github.com/acme/api/issues/7"),
    executionId: Option.none(),
    subjects: [],
    status: "running",
    currentStep: Option.none(),
    summary: Option.none(),
    configTree: Option.none(),
    startedAt: "2026-10-31T11:00:00.000Z",
    finishedAt: Option.none(),
    ...fields,
  });

const step = (name: string, enteredAt: string) => RunStep.make({ step: name, enteredAt });

const finishedRun = run({
  status: "done",
  subjects: ["pr-12"],
  summary: Option.some("Opened #12"),
  finishedAt: Option.some("2026-10-31T11:30:00.000Z"),
});

const finishedHistory = RunHistory.make({
  steps: [
    step("implement", "2026-10-31T11:00:05.000Z"),
    step("open-pr", "2026-10-31T11:25:00.000Z"),
  ],
  waits: [],
});

const finishedFound = { kind: "found" as const, run: finishedRun, history: finishedHistory };

const finished: Detail = finishedFound;

const parked: Detail = {
  kind: "found",
  run: run({ currentStep: Option.some("await-ci") }),
  history: RunHistory.make({
    steps: [step("await-ci", "2026-10-31T11:10:00.000Z")],
    waits: [
      RunWait.make({
        runId: RunId.make(ID),
        signal: "ci-finished",
        deferred: "ci:12",
        token: "t",
        parkedAt: Option.some("2026-10-31T11:10:00.000Z"),
      }),
    ],
  }),
};

const logOf = (lines: ReadonlyArray<string>, connection: LogState["connection"]): LogState => ({
  lines,
  connection,
});

const render = (
  detail: Detail,
  log: LogState = initialLog,
  asked = ID,
  shownStep: Option.Option<string> = Option.none(),
) =>
  renderToStaticMarkup(
    <RunDetailView
      asked={asked}
      detail={detail}
      log={log}
      now={NOW}
      slug={Option.some("acme/api")}
      step={shownStep}
    />,
  );

// A run on a pull request that named it again, and named another.
const onPullRequest: Detail = {
  kind: "found",
  run: run({
    flow: "review",
    itemKey: "pr-12",
    itemUrl: Option.none(),
    subjects: ["pr-12", "issue-7", "slack-thread"],
  }),
  history: finishedHistory,
};

// An epic whose tasks ran at once.
const epicFound = {
  kind: "found" as const,
  run: run({ flow: "epic" }),
  history: RunHistory.make({
    steps: [
      step("claim-epic", "2026-10-31T11:00:00.000Z"),
      step("implement#task-1", "2026-10-31T11:00:05.000Z"),
      step("implement#task-2", "2026-10-31T11:00:06.000Z"),
    ],
    waits: [],
  }),
};

const epic: Detail = epicFound;

describe("the run's detail", () => {
  test("renders a finished run: its row, its steps, its pull request, its summary and its log", () => {
    const page = render(
      finished,
      logOf(["started", "step: implement", "finished: done"], { kind: "ended" }),
    );

    expect(page).toContain("api/implement issue-7 as bob");
    expect(page).toContain("Fix the parser");
    expect(page).toContain('class="badge done"');
    expect(page).toContain("Opened #12");
    expect(page).toContain('href="https://github.com/acme/api/pull/12"');
    expect(page).toContain("pr-12");
    expect(page).toContain("implement");
    expect(page).toContain("open-pr");
    expect(page).toContain(ID);
    expect(page).toMatch(
      /<pre[^>]*class="log"[^>]*>started\nstep: implement\nfinished: done<\/pre>/,
    );
    expect(page).toContain("The log is complete.");
  });

  test("links the item it's on, and names each other subject once, linked where GitHub has it", () => {
    const page = render(onPullRequest);

    expect(page).toContain(
      '<dt>Item</dt><dd><a href="https://github.com/acme/api/pull/12">pr-12</a>',
    );
    expect(page.match(/>pr-12</g)).toHaveLength(1);
    expect(page).toContain('<a href="https://github.com/acme/api/issues/7">issue-7</a>');
    expect(page).toContain("<span>slack-thread</span>");
    expect(page).not.toContain("Pull request");
    expect(githubUrl(Option.none(), "pr-12")).toEqual(Option.none());
    expect(githubUrl(Option.some("acme/api"), "pr-12-review-2")).toEqual(Option.none());
  });

  test("draws its steps as lanes, each step linking to its own page", () => {
    const page = render(epic);

    expect(page).toContain('aria-label="lane run"');
    expect(page).toContain('aria-label="lane task-1"');
    expect(page).toContain('aria-label="lane task-2"');
    expect(page).toContain(`href="#/runs/${ID}/steps/implement%23task-1"`);
  });

  test("on a step's page, marks the step, says what's known of it, and shows its log alone", () => {
    const page = render(
      finished,
      logOf(["step: open-pr", "opened #12"], { kind: "ended" }),
      ID,
      Option.some("open-pr"),
    );

    expect(page).toMatch(/aria-current="step"[^>]*>(?:(?!<\/a>).)*open-pr/);
    expect(page).toContain('aria-label="Step"');
    expect(page).toContain("Log of open-pr");
    expect(page).toContain(`href="#/runs/${ID}"`);
    expect(page).toMatch(/<pre[^>]*class="log"[^>]*>step: open-pr\nopened #12<\/pre>/);
  });

  test("says so on a step's page when the log can't be split by step", () => {
    const page = render(
      epic,
      logOf(["a", "b"], { kind: "ended" }),
      ID,
      Option.some("implement#task-1"),
    );

    expect(page).toContain("can&#x27;t be split by step");
    expect(page).not.toContain('class="log"');
  });

  test("names a step the run doesn't have", () => {
    expect(render(finished, initialLog, ID, Option.some("deploy"))).toContain(
      "This run has no step deploy.",
    );
  });

  test("renders a parked run: what it waits on, since when", () => {
    const page = render(parked, logOf(["started"], { kind: "live" }));

    expect(page).toContain('class="badge parked"');
    expect(page).toContain("ci-finished");
    expect(page).toContain("ci:12");
    expect(page).toContain("await-ci");
    expect(page).not.toContain("The log is complete.");
  });

  test("renders an id the daemon has no run for", () => {
    const page = render({ kind: "unknown" }, initialLog, "nobody");

    expect(page).toContain("No run nobody");
    expect(page).toContain('href="#/"');
    expect(page).not.toContain('class="log"');
  });

  test("renders what the daemon refused with", () => {
    const page = render(
      { kind: "refused", message: "5714 names 2 runs (…); give more of the id" },
      initialLog,
      "5714",
    );

    expect(page).toContain("give more of the id");
  });
});

// A daemon that answers each path with what `reply` makes of it, and the
// paths it was asked for.
const daemonAnswering = (reply: (path: string) => Response) => {
  const asked: Array<string> = [];

  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      asked.push(url.pathname);

      return HttpClientResponse.fromWeb(request, reply(url.pathname));
    }),
  );

  return { asked, client };
};

const encodeRun = Schema.encodeSync(Schema.toCodecJson(RunReply));
const encodeHistory = Schema.encodeSync(Schema.toCodecJson(RunHistory));

const loaded = (daemon: ReturnType<typeof daemonAnswering>, asked: string) =>
  loadDetail("http://127.0.0.1:4848", asked).pipe(
    Effect.provideService(HttpClient.HttpClient, daemon.client),
  );

describe("loading a run", () => {
  it.live("asks for the run by what was asked, then its history by its whole id", () =>
    Effect.gen(function* () {
      const daemon = daemonAnswering((path) =>
        Response.json(
          Option.match(
            Option.liftPredicate(path, (asked) => asked.endsWith("/history")),
            {
              onNone: () => encodeRun(Option.some(finishedRun)),
              onSome: () => encodeHistory(finishedHistory),
            },
          ),
        ),
      );

      const detail = yield* loaded(daemon, "5714");

      expect(daemon.asked).toEqual(["/api/runs/5714", `/api/runs/${ID}/history`]);
      expect(detail).toEqual(finished);
    }),
  );

  it.live("an id the daemon has no run for is unknown", () =>
    Effect.gen(function* () {
      const daemon = daemonAnswering(() => Response.json(encodeRun(Option.none())));

      expect(yield* loaded(daemon, "nobody")).toEqual({ kind: "unknown" });
    }),
  );

  it.live("a refusal says the daemon's reason", () =>
    Effect.gen(function* () {
      const daemon = daemonAnswering(() =>
        Response.json({ error: "5714 names 2 runs; give more of the id" }, { status: 409 }),
      );

      expect(yield* loaded(daemon, "5714")).toEqual({
        kind: "refused",
        message: "5714 names 2 runs; give more of the id",
      });
    }),
  );
});

describe("what loads the run again", () => {
  const entered: Heard = {
    kind: "event",
    event: RunEnteredStep.make({
      eventId: "s",
      runId: RunId.make(ID),
      step: "open-pr",
      enteredAt: "now",
    }),
  };

  const parkedEvent: Heard = {
    kind: "event",
    event: RunNeedsAttention.make({
      eventId: "p",
      runId: RunId.make(ID),
      signal: "ci-finished",
      deferred: "ci:12",
      parkedAt: "now",
    }),
  };

  const stepEnded: Heard = {
    kind: "event",
    event: RunFinishedStep.make({
      eventId: "e",
      runId: RunId.make(ID),
      step: "open-pr",
      outcome: "ok",
      finishedAt: "now",
    }),
  };

  const ended: Heard = {
    kind: "event",
    event: RunFinished.make({
      eventId: "f",
      runId: RunId.make(ID),
      status: "done",
      summary: "Opened #12",
      finishedAt: "now",
    }),
  };

  test("its own steps starting and ending, parking and ending", () => {
    expect([entered, stepEnded, parkedEvent, ended].map((said) => refetchesFor(said, ID))).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  test("not another run's, nor another kind of event", () => {
    const another: Heard = {
      kind: "event",
      event: RunFinished.make({
        eventId: "g",
        runId: RunId.make("other"),
        status: "failed",
        summary: "",
        finishedAt: "now",
      }),
    };

    const changed: Heard = {
      kind: "event",
      event: StatusChanged.make({ eventId: "c", files: ["config.yaml"], at: "now" }),
    };

    expect(refetchesFor(another, ID)).toBe(false);
    expect(refetchesFor(changed, ID)).toBe(false);
  });
});

describe("the log", () => {
  test("keeps the last 10,000 lines", () => {
    const many = Array.from({ length: MAX_LOG_LINES }, (_, index) => `line ${index}`);
    const kept = appended(many, "one more\nand another");

    expect(kept.length).toBe(MAX_LOG_LINES);
    expect(kept[0]).toBe("line 2");
    expect(kept.at(-1)).toBe("and another");
  });

  test("starts over on each connection, and ends with the run", () => {
    const said: ReadonlyArray<LogHeard> = [
      { kind: "connected" },
      { kind: "text", text: "started" },
      { kind: "connected" },
      { kind: "text", text: "started\nstep: implement" },
      { kind: "end" },
    ];

    const log = said.reduce(hearLog, initialLog);

    expect(log.lines).toEqual(["started", "step: implement"]);
    expect(log.connection).toEqual({ kind: "ended" });
  });

  it.live("reads GET /api/runs/:id/log's pieces, then its end", () =>
    Effect.gen(function* () {
      const daemon = daemonAnswering(
        () =>
          new Response(
            "data: started\n\n: ping\n\ndata: step: implement\ndata: wrote\n\nevent: end\ndata: \n\n",
            {
              headers: { "content-type": "text/event-stream" },
            },
          ),
      );

      const said = yield* Stream.runCollect(runLogFeed("http://127.0.0.1:4848", ID)).pipe(
        Effect.provideService(HttpClient.HttpClient, daemon.client),
      );

      expect(daemon.asked).toEqual([`/api/runs/${ID}/log`]);
      expect(said).toEqual([
        { kind: "connected" },
        { kind: "text", text: "started" },
        { kind: "text", text: "step: implement\nwrote" },
        { kind: "end" },
      ]);
    }),
  );
});

// The epic as a daemon that keeps steps' ends, the lanes and each line's step sends it.
const keptEpic = {
  ...epicFound,
  history: RunHistory.make({
    steps: [
      RunStep.make({
        step: "claim-epic",
        enteredAt: "2026-10-31T11:00:00.000Z",
        finishedAt: "2026-10-31T11:00:04.000Z",
        outcome: "ok",
      }),
      RunStep.make({
        step: "implement#task-1",
        enteredAt: "2026-10-31T11:00:05.000Z",
        finishedAt: "2026-10-31T11:10:05.000Z",
        outcome: "failed",
      }),
      step("implement#task-2", "2026-10-31T11:10:06.000Z"),
    ],
    waits: [],
    lanes: [RunHistory.fields.lanes.schema.value.make({ lane: "task-2", needs: ["task-1"] })],
    stepLogs: "tagged",
  }),
};

describe("a run the daemon kept steps' ends and lanes for", () => {
  test("marks each step by how it ended, and how long it took", () => {
    const page = render(keptEpic);

    expect(page).toMatch(/class="chip ok"[^>]*>(?:(?!<\/a>).)*claim-epic(?:(?!<\/a>).)*4s/);
    expect(page).toMatch(/class="chip failed"[^>]*>(?:(?!<\/a>).)*implement(?:(?!<\/a>).)*10m 00s/);
    expect(page).toContain('class="lane failed"');
  });

  test("puts a task after the one it waited on", () => {
    const page = render(keptEpic);

    expect(page.indexOf('data-lane="task-2"')).toBeGreaterThan(page.indexOf('data-lane="task-1"'));
    expect(page.match(/class="column"/g)).toHaveLength(3);
  });

  test("asks the daemon for a step's lines, even of lanes that ran at once", () => {
    expect(stepLogMode(keptEpic)).toBe("server");
    expect(
      stepLogMode({ ...keptEpic, history: { ...keptEpic.history, stepLogs: "unavailable" } }),
    ).toBe("none");
  });
});

describe("a step's log", () => {
  test("of a run on one line, the page splits from the whole log", () => {
    expect(stepLogMode(finishedFound)).toBe("page");
  });

  test("of a run whose lanes ran at once, from a daemon that kept no step, can't be had", () => {
    expect(stepLogMode(epicFound)).toBe("none");
  });

  test("is the lines from the step's start to the next step's, with or without times", () => {
    const lines = [
      "2026-10-31T11:00:00.000Z step: claim",
      "claimed #7",
      "2026-10-31T11:00:05.000Z step: implement",
      "Bash(ls)",
      "step: open-pr",
      "opened #12",
    ];

    expect(linesOfStep(lines, "implement")).toEqual([
      "2026-10-31T11:00:05.000Z step: implement",
      "Bash(ls)",
    ]);
    expect(linesOfStep(lines, "open-pr")).toEqual(["step: open-pr", "opened #12"]);
    expect(linesOfStep(lines, "push")).toEqual([]);
  });
});
