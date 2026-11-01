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
  RunHistory,
  RunNeedsAttention,
  RunReply,
  StatusChanged,
} from "#daemon/protocol";

import type { Heard } from "./feed.ts";
import { type Detail, loadDetail, refetchesFor } from "./run.ts";
import { RunDetailView } from "./run-detail.tsx";
import {
  appended,
  hearLog,
  initialLog,
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

const finished: Detail = { kind: "found", run: finishedRun, history: finishedHistory };

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

const render = (detail: Detail, log: LogState = initialLog, asked = ID) =>
  renderToStaticMarkup(
    <RunDetailView
      asked={asked}
      detail={detail}
      log={log}
      now={NOW}
      slug={Option.some("acme/api")}
    />,
  );

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

  test("its own steps, parking and ending", () => {
    expect([entered, parkedEvent, ended].map((said) => refetchesFor(said, ID))).toEqual([
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
