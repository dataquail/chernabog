import { makeEventBus } from "@effect-server-utils/cqrs";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  foldInUnitOfWork,
  foldSpoke,
  ReportFold,
  reportFold,
} from "../src/interface/daemon/report-fold.server.ts";
import {
  activityOf,
  hubSpokes,
  isSpoke,
  journalSignature,
  type LeftSpoke,
  measureOf,
  nextActivity,
  spokeArgs,
  spokeEnvironment,
  type SpokeHandOver,
  tailSpoke,
  telemetryByRun,
} from "../src/interface/daemon/spokes.server.ts";
import { RunId } from "../src/kernel/run-id.id.ts";
import {
  breachOf,
  breachSummary,
  DEFAULT_SPOKE_BOUNDS,
} from "../src/kernel/spoke-bounds.value-object.ts";
import { RunLogsClientFake } from "../src/modules/runs/infrastructure/clients/run-logs.client-fake.ts";
import { HoldsRepositoryLive } from "../src/modules/runs/infrastructure/repositories/holds.repository-live.ts";
import { RunCreatedIssuesRepositoryLive } from "../src/modules/runs/infrastructure/repositories/run-created-issues.repository-live.ts";
import { RunLanesRepositoryLive } from "../src/modules/runs/infrastructure/repositories/run-lanes.repository-live.ts";
import { RunMarkersRepositoryLive } from "../src/modules/runs/infrastructure/repositories/run-markers.repository-live.ts";
import { RunNodesRepositoryLive } from "../src/modules/runs/infrastructure/repositories/run-nodes.repository-live.ts";
import { RunPlansRepositoryLive } from "../src/modules/runs/infrastructure/repositories/run-plans.repository-live.ts";
import { RunSpokesRepositoryLive } from "../src/modules/runs/infrastructure/repositories/run-spokes.repository-live.ts";
import { RunStepsRepositoryLive } from "../src/modules/runs/infrastructure/repositories/run-steps.repository-live.ts";
import { RunWaitsRepositoryLive } from "../src/modules/runs/infrastructure/repositories/run-waits.repository-live.ts";
import { RunsRepositoryLive } from "../src/modules/runs/infrastructure/repositories/runs.repository-live.ts";
import { SkipsRepositoryLive } from "../src/modules/runs/infrastructure/repositories/skips.repository-live.ts";
import { TokenUsageCursorsRepositoryLive } from "../src/modules/runs/infrastructure/repositories/token-usage-cursors.repository-live.ts";
import { TokenUsagesRepositoryLive } from "../src/modules/runs/infrastructure/repositories/token-usages.repository-live.ts";
import { JournalsAt, RunJournals } from "../src/modules/runs/infrastructure/runtime/journals.ts";
import { RunsCommandsLive } from "../src/modules/runs/runs.command-handlers.ts";
import {
  endingOf,
  RunsCommands,
  RunsModule,
  RunsQueries,
  type RunStatus,
  RunView,
  type SpokeReport,
  SpokeReportCommand,
  spokeReportPayloadJson,
} from "../src/modules/runs/runs.platform.ts";
import { RunsQueriesLive } from "../src/modules/runs/runs.query-handlers.ts";
import {
  groupAlive,
  processIdentity,
  spawnGroup,
  stopGroup,
} from "../src/platform/process-group.ts";
import { effect } from "./effect-test.ts";
import { sqliteAfter } from "./sqlite.ts";

const run = RunView.make({
  id: RunId.make("3f2a"),
  repo: "demo",
  persona: Option.some("chernabog-bot"),
  flow: "implement",
  itemKey: "issue-7",
  itemTitle: Option.none(),
  itemUrl: Option.none(),
  executionId: Option.some("execution-3f2a"),
  status: "running",
  currentStep: Option.none(),
  summary: Option.none(),
  coreVersion: "0.6.0",
  startedAt: "2026-11-25T00:00:00.000Z",
  finishedAt: Option.none(),
});

const handOver = (fields: Partial<SpokeHandOver> = {}): SpokeHandOver => ({
  runId: RunId.make("3f2a"),
  run,
  repo: "demo",
  checkout: "/work/demo",
  flow: "implement",
  persona: Option.some("chernabog-bot"),
  item: { key: "issue-7", data: { issue: 7 } },
  tree: Option.some("abc123"),
  ...fields,
});

describe("a spoke's hand-over", () => {
  test("is `ci run --run` with the run, its repo, flow, persona, item and tree", () => {
    expect(spokeArgs(handOver(), "/home/spokes/3f2a.hand-over.json", DEFAULT_SPOKE_BOUNDS)).toEqual(
      [
        "ci",
        "run",
        "--run",
        "3f2a",
        "--repo",
        "demo",
        "--flow",
        "implement",
        "--persona",
        "chernabog-bot",
        "--item",
        "issue-7",
        "--hand-over-file",
        "/home/spokes/3f2a.hand-over.json",
        "--tree",
        "abc123",
        // Its byte bounds, which it caps its own writes at, and its own stop a
        // margin past its phase-time bound (4 hours and 5 minutes), so the
        // hub's bound is the one that ends it.
        "--telemetry-limit",
        "256000000",
        "--run-log-limit",
        "32000000",
        "--stop-after-seconds",
        "14700",
      ],
    );
  });

  test("names no persona for the implicit one, and no tree for a working copy's", () => {
    const args = spokeArgs(
      handOver({ persona: Option.none(), tree: Option.none() }),
      "/home/spokes/3f2a.hand-over.json",
      DEFAULT_SPOKE_BOUNDS,
    );

    expect(args).not.toContain("--persona");
    expect(args).not.toContain("--tree");
  });

  test("runs in the hub's home, and never with an API key, which bills claude by the token", () => {
    expect(
      spokeEnvironment(
        { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant", CHERNABOG_HOME: "/elsewhere" },
        "/home",
      ),
    ).toEqual({ PATH: "/usr/bin", CHERNABOG_HOME: "/home" });
  });
});

// A report as a spoke writes it: a runs' command's payload, coded with its schema.
const reported = (seq: number, step: string): SpokeReport => ({
  seq,
  at: "2026-11-25T00:00:01.000Z",
  tag: "EnterStepCommand",
  payload: Schema.encodeSync(spokeReportPayloadJson(SpokeReportCommand.EnterStepCommand))({
    runId: RunId.make("3f2a"),
    step,
    at: "2026-11-25T00:00:01.000Z",
  }),
});

const encodeOpened = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ adapter: Schema.String, sessionId: Schema.String, launch: Schema.String }),
  ),
);

describe("folding a spoke's reports", () => {
  test("a report is the runs' command it carries, with the payload the spoke wrote", () => {
    expect(reportFold(reported(1, "claim"))).toEqual(
      ReportFold.Dispatch({
        command: SpokeReportCommand.EnterStepCommand,
        payload: { runId: RunId.make("3f2a"), step: "claim", at: "2026-11-25T00:00:01.000Z" },
      }),
    );
  });

  test("the spoke's ending is read apart, and a report it can't fold is skipped, saying why", () => {
    expect(reportFold({ seq: 9, at: "", tag: "RunEnded", payload: "{}" })).toEqual(
      ReportFold.Ending(),
    );
    expect(reportFold({ seq: 2, at: "", tag: "FinishRunCommand", payload: "{}" })).toEqual(
      ReportFold.Skip({ why: "the hub skipped a report it doesn't fold: FinishRunCommand" }),
    );
    expect(reportFold({ seq: 3, at: "", tag: "EnterStepCommand", payload: "{" })).toEqual(
      ReportFold.Skip({ why: "the hub skipped a EnterStepCommand whose payload it couldn't read" }),
    );
  });

  test("an agent session the spoke opened is kept on the spoke, and one that won't read skipped", () => {
    const opened = { adapter: "claude", sessionId: "s-1", launch: "/home/s-1/launch.json" };

    expect(
      reportFold({ seq: 4, at: "", tag: "AgentSessionOpened", payload: encodeOpened(opened) }),
    ).toEqual(ReportFold.Session({ opened }));
    expect(reportFold({ seq: 5, at: "", tag: "AgentSessionOpened", payload: "{}" })).toEqual(
      ReportFold.Skip({
        why: "the hub skipped a AgentSessionOpened whose payload it couldn't read",
      }),
    );
  });

  effect("applies each report once, in order, however often it folds", () =>
    Effect.gen(function* () {
      const journal = [reported(1, "claim"), reported(2, "ci")];
      const applied: Array<number> = [];
      const folded = yield* Ref.make(0);

      const reports = (_runId: RunId, after: number) =>
        Effect.succeed(journal.filter((report) => report.seq > after));

      const apply = (_runId: RunId, report: SpokeReport) =>
        Effect.sync(() => {
          applied.push(report.seq);
        });

      yield* foldSpoke(RunId.make("3f2a"), folded, reports, apply);
      journal.push(reported(3, "push"));
      yield* foldSpoke(RunId.make("3f2a"), folded, reports, apply);
      yield* foldSpoke(RunId.make("3f2a"), folded, reports, apply);

      expect(applied).toEqual([1, 2, 3]);
      expect(yield* Ref.get(folded)).toBe(3);
    }),
  );

  effect("a fold stopped midway leaves no report for the next to apply again", () =>
    Effect.gen(function* () {
      const journal = [reported(1, "claim"), reported(2, "ci"), reported(3, "push")];
      const applied: Array<number> = [];
      const folded = yield* Ref.make(0);
      const dispatching = yield* Deferred.make<boolean>();
      const dispatched = yield* Deferred.make<boolean>();

      const reports = (_runId: RunId, after: number) =>
        Effect.succeed(journal.filter((report) => report.seq > after));

      // The second report's dispatch is under way when the tail is stopped.
      const apply = (_runId: RunId, report: SpokeReport) =>
        Effect.gen(function* () {
          if (report.seq === 2 && applied.length === 1) {
            yield* Deferred.succeed(dispatching, true);
            yield* Deferred.await(dispatched);
          }

          applied.push(report.seq);
        });

      const tail = yield* Effect.forkChild(foldSpoke(RunId.make("3f2a"), folded, reports, apply));
      yield* Deferred.await(dispatching);
      const stopping = yield* Effect.forkChild(Fiber.interrupt(tail));
      yield* Deferred.succeed(dispatched, true);
      yield* Fiber.join(stopping);
      yield* foldSpoke(RunId.make("3f2a"), folded, reports, apply);

      expect(applied).toEqual([1, 2, 3]);
    }),
  );
});

// A live spoke's journal in a home of the test's own: the spoke's connection,
// held open as a running spoke holds it, and the journal's path.
const liveJournal = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-tail-" });
  yield* fs.makeDirectory(`${home}/journals`);
  const path = `${home}/journals/3f2a.db`;

  const spoke = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const db = new Database(path);
      db.run("PRAGMA journal_mode = WAL");
      db.run(
        "CREATE TABLE spoke_reports (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, tag TEXT NOT NULL, payload TEXT NOT NULL)",
      );

      return db;
    }),
    (db) =>
      Effect.sync(() => {
        db.close();
      }),
  );

  const journals = yield* Layer.build(JournalsAt(home));

  return {
    fs,
    path,
    spoke,
    reports: Effect.provideContext(
      RunJournals.use((found) => found.reports(RunId.make("3f2a"), 0)),
      journals,
    ),
  };
});

describe("tailing a live spoke's journal", () => {
  effect("the hub reading a journal doesn't change what its files look like", () =>
    Effect.gen(function* () {
      const live = yield* liveJournal;
      live.spoke.run(
        "INSERT INTO spoke_reports (at, tag, payload) VALUES ('', 'EnterStepCommand', '{}')",
      );
      const before = yield* journalSignature(live.fs, live.path);

      expect(yield* live.reports).toHaveLength(1);
      expect(yield* live.reports).toHaveLength(1);
      expect(yield* journalSignature(live.fs, live.path)).toBe(before);

      live.spoke.run(
        "INSERT INTO spoke_reports (at, tag, payload) VALUES ('', 'FinishStepCommand', '{}')",
      );

      expect(yield* journalSignature(live.fs, live.path)).not.toBe(before);
    }),
  );

  effect("folds again only when the spoke wrote, however often the journals change", () =>
    Effect.gen(function* () {
      const live = yield* liveJournal;
      const changes = yield* Queue.unbounded<boolean>();
      const looks = yield* Queue.unbounded<boolean>();
      const folds = yield* Ref.make(0);

      // Each look at the journal's files, and each fold, a real read of it.
      yield* Effect.forkChild(
        tailSpoke({
          fold: live.reports.pipe(Effect.andThen(Ref.update(folds, (count) => count + 1))),
          signature: journalSignature(live.fs, live.path).pipe(
            Effect.tap(() => Queue.offer(looks, true)),
          ),
          changed: Queue.take(changes).pipe(Effect.asVoid),
          every: Duration.hours(1),
        }),
      );

      // A change event, and the tail's look at the journal that follows it.
      const change = Queue.offer(changes, true).pipe(Effect.andThen(Queue.take(looks)));

      yield* Queue.take(looks);

      // The events its own reads fire, which used to wake it to read again.
      for (let event = 0; event < 5; event += 1) {
        yield* change;
      }

      expect(yield* Ref.get(folds)).toBe(1);

      live.spoke.run(
        "INSERT INTO spoke_reports (at, tag, payload) VALUES ('', 'EnterStepCommand', '{}')",
      );
      yield* change;
      // The next look comes only after the fold the write started.
      yield* change;

      expect(yield* Ref.get(folds)).toBe(2);
    }),
  );
});

describe("ending a live spoke", () => {
  const runId = RunId.make("3f2a");

  effect(
    "a second ending asked once the spoke has left the live ones, before the first has its answer, hears the first",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-spokes-" });
        // Told when the hub handles the spoke's exit, which then waits for `gate`:
        // the window between the spoke leaving the live ones and the first
        // ending having its answer.
        const exiting = yield* Deferred.make<Option.Option<RunStatus>>();
        const gate = yield* Deferred.make<boolean>();
        // What the hub recorded of the spoke, and of the ending it meant.
        const recorded: Array<string> = [];

        const asked = (ending: "lost" | "superseded") => ({
          by: "chernabog",
          closeSessions: false,
          endAs: Option.some({ ending, reason: `it was ${ending}` }),
        });

        const spokes = yield* hubSpokes({
          home,
          command: ["sh", "-c", "exec sleep 30"],
          variables: {},
          log: () => Effect.void,
          reports: () => Effect.succeed([]),
          apply: () => Effect.void,
          record: (spoke) =>
            Effect.sync(() => {
              recorded.push(
                `spoke ${spoke.runId} ${spoke.pid > 0} ${Option.isSome(spoke.startedAt)} ${spoke.hubPid === process.pid}`,
              );
            }),
          intend: (meantFor, request) =>
            Effect.sync(() => {
              recorded.push(`meant ${meantFor} ${endingOf(request)}`);
            }),
          onExit: (_run, _exit, intended) =>
            Deferred.succeed(exiting, intended).pipe(Effect.andThen(Deferred.await(gate))),
          bounds: DEFAULT_SPOKE_BOUNDS,
          onBound: () => Effect.succeed(true),
        });

        yield* spokes.start(handOver({ checkout: home }));
        expect(spokes.has(runId)).toBe(true);

        const first = yield* Effect.forkChild(spokes.end(runId, asked("lost")));
        // The hub won't end the run from the exit: the first ending is meant.
        expect(yield* Deferred.await(exiting)).toEqual(Option.some("lost"));
        expect(spokes.has(runId)).toBe(false);

        const second = yield* Effect.forkChild(spokes.end(runId, asked("superseded")));
        yield* Deferred.succeed(gate, true);

        const [firstEnded, secondEnded] = [yield* Fiber.join(first), yield* Fiber.join(second)];

        expect(Option.map(firstEnded, (ended) => ended.endedFor)).toEqual(Option.some("lost"));
        expect(Option.map(secondEnded, (ended) => ended.endedFor)).toEqual(Option.some("lost"));
        expect(Option.map(firstEnded, (ended) => ended.exit)).toEqual(
          Option.some("killed by SIGTERM"),
        );

        // Once the run's ending is recorded the hub forgets the spoke, and no
        // spoke of the run is left to end.
        yield* spokes.forget(runId);
        expect(yield* spokes.end(runId, asked("lost"))).toEqual(Option.none());

        // Recorded once spawned, with its start time and the hub's own, and
        // the ending meant for it recorded once, the first.
        expect(recorded).toEqual([`spoke ${runId} true true true`, `meant ${runId} lost`]);
      }),
  );
});

describe("a spoke measured against its bounds", () => {
  const scratchHome = FileSystem.FileSystem.use((fs) =>
    fs.makeTempDirectoryScoped({ prefix: "chernabog-bounds-" }),
  );

  effect("its telemetry is every file named for its run, over every day folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const telemetry = `${yield* scratchHome}/telemetry`;

      yield* fs.makeDirectory(`${telemetry}/2026-11-24`, { recursive: true });
      yield* fs.makeDirectory(`${telemetry}/2026-11-25`, { recursive: true });
      yield* fs.writeFileString(`${telemetry}/2026-11-24/spoke-3f2a-100.jsonl`, "a".repeat(300));
      yield* fs.writeFileString(`${telemetry}/2026-11-25/spoke-3f2a-100.jsonl`, "a".repeat(200));
      yield* fs.writeFileString(`${telemetry}/2026-11-25/spoke-9b9b-7.jsonl`, "b".repeat(50));
      yield* fs.writeFileString(`${telemetry}/2026-11-25/daemon-1.jsonl`, "c".repeat(999));

      const byRun = yield* telemetryByRun(fs, telemetry);

      expect([...byRun.entries()].toSorted()).toEqual([
        ["3f2a", 500],
        ["9b9b", 50],
      ]);
    }),
  );

  effect("its activity moves when its journal, its run log or a transcript grows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* scratchHome;
      const runId = RunId.make("3f2a");
      const transcript = `${home}/claude/projects/demo/s1.jsonl`;
      const subagents = `${home}/claude/projects/demo/s1`;
      yield* fs.makeDirectory(`${subagents}/subagents`, { recursive: true });
      yield* fs.makeDirectory(`${home}/runs`, { recursive: true });

      const sessions = [
        { adapter: "claude", sessionId: "s1", launch: "/l", transcripts: [transcript, subagents] },
      ];

      const signature = activityOf(fs, home, runId, sessions);

      const first = yield* signature;
      expect(yield* signature).toBe(first);

      yield* fs.writeFileString(`${home}/runs/${runId}.log`, "step: claim\n");
      const afterLog = yield* signature;
      expect(afterLog).not.toBe(first);

      yield* fs.writeFileString(transcript, "{}\n");
      const afterTranscript = yield* signature;
      expect(afterTranscript).not.toBe(afterLog);

      yield* fs.writeFileString(`${subagents}/subagents/agent-1.jsonl`, "{}\n");
      expect(yield* signature).not.toBe(afterTranscript);
    }),
  );

  test("idle is the time since its files last changed; phase time since it was spawned", () => {
    const started = { signature: "", at: 0 };
    const working = nextActivity(started, "j1", 60_000);
    const unchanged = nextActivity(working, "j1", 40 * 60_000);

    expect(working).toEqual({ signature: "j1", at: 60_000 });
    expect(unchanged).toBe(working);

    const measure = measureOf({
      now: 40 * 60_000,
      startedAt: 0,
      activity: unchanged,
      telemetry: 0,
      runLog: 0,
      memory: Option.some(200_000_000),
    });

    expect(Duration.toMinutes(measure.idle)).toBe(39);
    expect(Duration.toMinutes(measure.phaseTime)).toBe(40);
    expect(Option.map(breachOf(measure, DEFAULT_SPOKE_BOUNDS), breachSummary)).toEqual(
      Option.some("ended past its idle bound: 39m over 30m"),
    );
  });
});

// A process standing in for a spoke the hub before left, its command line
// naming the run as a spoke's does, once it has done what `first` says.
const leftProcess = (runId: string, first: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const group = yield* spawnGroup(
      "sh",
      ["-c", [...first, "echo ready", "sleep 60", `: ci run --run ${runId}`].join("; ")],
      { cwd: "/", env: { PATH: "/bin:/usr/bin" } },
    );

    yield* Stream.runHead(group.lines);

    return group;
  });

const left = (runId: string, fields: Partial<LeftSpoke> = {}): LeftSpoke => ({
  runId: RunId.make(runId),
  pid: 0,
  startedAt: Option.none(),
  foldedSeq: 0,
  ending: Option.none(),
  ...fields,
});

const interrupted = {
  by: "chernabog",
  closeSessions: false,
  endAs: Option.some({ ending: "interrupted" as const, reason: "its hub stopped" }),
};

const cancelledByAlice = { by: "alice", closeSessions: true, endAs: Option.none() };

// A hub in a home of the test's own, over a journal holding `reports` (none
// for one it can't read), folding them into `applied` by their seq.
const hubOver = (reports: Option.Option<ReadonlyArray<SpokeReport>>, applied: Array<number>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-reap-" });

    return yield* hubSpokes({
      home,
      variables: {},
      log: () => Effect.void,
      reports: (_runId, after) =>
        Option.match(reports, {
          onNone: () => Effect.die("file is not a database"),
          onSome: (held) => Effect.succeed(held.filter((report) => report.seq > after)),
        }),
      apply: (_runId, report) =>
        Effect.sync(() => {
          applied.push(report.seq);
        }),
      record: () => Effect.void,
      intend: () => Effect.void,
      onExit: () => Effect.void,
      bounds: DEFAULT_SPOKE_BOUNDS,
      onBound: () => Effect.succeed(true),
      memory: Effect.succeed(new Map()),
      reapGrace: Duration.millis(300),
    });
  });

describe("reaping the spokes of the hub before", () => {
  test("a process is that spoke only by its start time and a command line naming its run", () => {
    const found = {
      startedAt: "Wed Nov 25 10:00:00 2026",
      command: "bun main.ts ci run --run r-1",
    };

    const recorded = left("r-1", { startedAt: Option.some(found.startedAt) });

    expect(isSpoke(recorded, found)).toBe(true);
    expect(isSpoke(recorded, { ...found, startedAt: "Wed Nov 25 10:00:01 2026" })).toBe(false);
    expect(isSpoke(recorded, { ...found, command: "bun main.ts ci run --run r-10" })).toBe(false);
    expect(isSpoke(recorded, { ...found, command: "vim notes" })).toBe(false);
    expect(isSpoke(left("r-1"), found)).toBe(true);
  });

  effect("ends one still running, that ignores SIGTERM, once it has checked its PID", () =>
    Effect.gen(function* () {
      const spokes = yield* hubOver(Option.some([]), []);
      const group = yield* leftProcess("r-1", ["trap '' TERM"]);
      const startedAt = Option.map(yield* processIdentity(group.pid), (found) => found.startedAt);

      const reaped = yield* spokes.reap(left("r-1", { pid: group.pid, startedAt }));

      expect(reaped.process).toBe("was still running, and was killed by SIGKILL");
      expect(yield* groupAlive(group.pid)).toBe(false);
    }),
  );

  effect("leaves alone a process that has the PID by reuse, or that is another run's", () =>
    Effect.gen(function* () {
      const spokes = yield* hubOver(Option.some([]), []);
      const group = yield* leftProcess("r-1");
      const startedAt = Option.map(yield* processIdentity(group.pid), (found) => found.startedAt);

      const reused = yield* spokes.reap(
        left("r-1", { pid: group.pid, startedAt: Option.some("Thu Jan 1 00:00:00 2015") }),
      );

      const another = yield* spokes.reap(left("r-2", { pid: group.pid, startedAt }));

      expect([reused.process, another.process]).toEqual([
        `was gone: PID ${group.pid} is another process's now, which the hub leaves alone`,
        `was gone: PID ${group.pid} is another process's now, which the hub leaves alone`,
      ]);
      expect(yield* groupAlive(group.pid)).toBe(true);

      yield* stopGroup(group, Duration.millis(300));
    }),
  );

  effect(
    "folds its journal past the position recorded, and answers for it with the ending meant first and the sessions it reported",
    () =>
      Effect.gen(function* () {
        const applied: Array<number> = [];

        const opened: SpokeReport = {
          seq: 1,
          at: "2026-11-25T00:00:01.000Z",
          tag: "AgentSessionOpened",
          payload: encodeOpened({ adapter: "claude", sessionId: "s-1", launch: "/l/s-1" }),
        };

        const spokes = yield* hubOver(
          Option.some([opened, reported(2, "claim"), reported(3, "work"), reported(4, "push")]),
          applied,
        );

        const reaped = yield* spokes.reap(
          left("r-1", { foldedSeq: 2, ending: Option.some(cancelledByAlice) }),
        );

        expect(reaped).toEqual({ process: "was gone", journalRead: true });
        expect(applied).toEqual([3, 4]);
        expect(spokes.has(RunId.make("r-1"))).toBe(false);

        const ended = Option.getOrThrow(yield* spokes.end(RunId.make("r-1"), interrupted));

        expect(ended.endedFor).toBe("cancelled");
        expect(ended.exit).toBe("its spoke from before was gone");
        expect(ended.sessions.map((session) => session.sessionId)).toEqual(["s-1"]);

        // One the hub before meant nothing for ends as first asked.
        yield* spokes.reap(left("r-2"));

        expect(
          Option.map(yield* spokes.end(RunId.make("r-2"), interrupted), (one) => one.endedFor),
        ).toEqual(Option.some("interrupted"));
        expect(
          Option.map(yield* spokes.end(RunId.make("r-2"), cancelledByAlice), (one) => one.endedFor),
        ).toEqual(Option.some("interrupted"));

        // Forgotten once its run's ending is recorded.
        yield* spokes.forget(RunId.make("r-2"));

        expect(yield* spokes.end(RunId.make("r-2"), interrupted)).toEqual(Option.none());
      }),
  );

  effect("says a journal it can't read, and folds nothing from it", () =>
    Effect.gen(function* () {
      const applied: Array<number> = [];
      const spokes = yield* hubOver(Option.none(), applied);

      expect(yield* spokes.reap(left("r-1"))).toEqual({ process: "was gone", journalRead: false });
      expect(applied).toEqual([]);
    }),
  );
});

describe("folding a report into state.db", () => {
  // The runs' commands and queries over a state.db of the test's own, with
  // the unit of work they declare, as the hub has them.
  const stateDb = Layer.mergeAll(RunsCommandsLive, RunsQueriesLive).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        RunsRepositoryLive,
        RunMarkersRepositoryLive,
        HoldsRepositoryLive,
        RunCreatedIssuesRepositoryLive,
        RunLanesRepositoryLive,
        RunNodesRepositoryLive,
        RunPlansRepositoryLive,
        RunWaitsRepositoryLive,
        SkipsRepositoryLive,

        RunSpokesRepositoryLive,
        RunStepsRepositoryLive,
        TokenUsagesRepositoryLive,
        TokenUsageCursorsRepositoryLive,
        RunLogsClientFake({}),
        makeEventBus(),
        RunsModule.unitOfWork,
      ),
    ),
    Layer.provideMerge(sqliteAfter(Effect.void)),
  );

  effect(
    "commits a report and the position past it together, and a refused report alone rolls back",
    () =>
      Effect.gen(function* () {
        const runs = yield* RunsCommands;
        const queries = yield* RunsQueries;
        const inOneUnitOfWork = yield* RunsModule.inOneUnitOfWork;
        const runId = RunId.make("3f2a");
        const advance = (seq: number) => runs.AdvanceSpokeFoldCommand({ runId, seq });

        const hold = runs
          .HoldMarkerCommand({ runId, name: "chernabog/label", args: { number: 7 }, keepOn: [] })
          .pipe(Effect.asVoid);

        const position = queries
          .ListSpokesQuery({})
          .pipe(Effect.map((found) => found.spokes.map((spoke) => spoke.foldedSeq)));

        const held = queries
          .ListRunMarkersQuery({ runId, name: Option.none() })
          .pipe(Effect.map((found) => found.markers.length));

        yield* runs.RecordSpokeCommand({
          runId,
          pid: 42,
          startedAt: Option.none(),
          hubPid: 7,
          hubStartedAt: Option.none(),
        });

        // A hub that dies between the report and the position keeps neither,
        // so the next hub folds the report again, once.
        yield* Effect.exit(
          foldInUnitOfWork(
            inOneUnitOfWork,
            hold,
            Effect.andThen(advance(1), Effect.die("hub killed")),
          ),
        );

        expect([yield* held, yield* position]).toEqual([0, [0]]);

        // A report whose command is refused (no such run) is skipped: the
        // position moves past it, and nothing else is kept.
        yield* foldInUnitOfWork(
          inOneUnitOfWork,
          runs
            .EnterStepCommand({ runId: RunId.make("missing"), step: "claim" })
            .pipe(Effect.result, Effect.asVoid),
          advance(1),
        );

        expect([yield* held, yield* position]).toEqual([0, [1]]);

        yield* foldInUnitOfWork(inOneUnitOfWork, hold, advance(2));

        expect([yield* held, yield* position]).toEqual([1, [2]]);
      }).pipe(Effect.provide(stateDb)),
  );
});
