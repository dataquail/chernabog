import { Database } from "bun:sqlite";
import { describe, expect } from "bun:test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunView } from "../../domain/run/run-view.value-object.ts";
import { decodeSpokeReport, SpokeReportCommand } from "../../runs.command-handlers.ts";
import { JournalsAt, RunJournals } from "./journals.ts";
import { RunRecords, RunRecordsInJournal } from "./run-records.ts";

const runId = RunId.make("3f2a");

const handOver = {
  run: RunView.make({
    id: runId,
    repo: "demo",
    persona: Option.some("bob"),
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
  }),
  item: { key: "issue-7", data: { issue: 7 } },
};

// Where the test's spoke finds state.db.
class TestState extends Context.Service<TestState, { readonly path: string }>()("TestState") {}

// A spoke's records over its run's journal, in a home of the test's own,
// whose state.db holds `cursors`, or which has none.
const spokeIn = (cursors: Option.Option<ReadonlyArray<readonly [string, string, string]>>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-records-" });
      const state = `${home}/state.db`;
      yield* fs.makeDirectory(`${home}/journals`);
      // The run's journal, as its engine makes it when the run executes.
      new Database(`${home}/journals/${runId}.db`).close();

      for (const rows of Option.toArray(cursors)) {
        const db = new Database(state);
        db.run("PRAGMA journal_mode = WAL");
        db.run(`CREATE TABLE om_usage_cursors (
          adapter TEXT NOT NULL, session_id TEXT NOT NULL, cursor TEXT NOT NULL,
          PRIMARY KEY (adapter, session_id))`);

        for (const [adapter, session, cursor] of rows) {
          db.run("INSERT INTO om_usage_cursors VALUES (?, ?, ?)", [adapter, session, cursor]);
        }

        db.close();
      }

      const journals = JournalsAt(home);

      return Layer.mergeAll(
        journals,
        RunRecordsInJournal(handOver, state).pipe(Layer.provide(journals)),
        Layer.succeed(TestState, TestState.of({ path: state })),
      );
    }),
  );

const reading = (cursor: string) =>
  Option.some({
    records: [
      {
        model: "opus",
        input: Option.some(10),
        output: Option.some(2),
        cacheRead: Option.none(),
        cacheWrite: Option.none(),
      },
    ],
    cursor,
  });

describe("a spoke's run records, in its journal", () => {
  effect(
    "appends each as its runs' command, in order, a step with the time the spoke took it",
    () =>
      Effect.gen(function* () {
        const records = yield* RunRecords;
        yield* records.enterStep({ runId, step: "claim" });
        yield* records.finishStep({ runId, step: "claim", outcome: "ok" });
        yield* records.nameSubject({ runId, subject: "pr-9" });

        const journals = yield* RunJournals;
        const reports = yield* journals.reports(runId, 0);

        expect(reports.map((report) => [report.seq, report.tag])).toEqual([
          [1, "EnterStepCommand"],
          [2, "FinishStepCommand"],
          [3, "NameSubjectCommand"],
        ]);

        const entered = reports.flatMap((report) =>
          Option.toArray(decodeSpokeReport(SpokeReportCommand.EnterStepCommand, report)),
        );

        // The time the spoke entered the step, not the fold's.
        expect(
          entered.map((one) => [one.step, Option.isSome(Option.fromUndefinedOr(one.at))]),
        ).toEqual([["claim", true]]);
        expect((yield* journals.reports(runId, 2)).map((report) => report.tag)).toEqual([
          "NameSubjectCommand",
        ]);
      }).pipe(Effect.provide(spokeIn(Option.none()))),
  );

  effect("reads the markers it holds back from its own reports, less those it forgot", () =>
    Effect.gen(function* () {
      const records = yield* RunRecords;
      yield* records.holdMarker({ runId, name: "claim", args: { item: "a" }, keepOn: [] });
      yield* records.holdMarker({ runId, name: "claim", args: { item: "b" }, keepOn: [] });
      yield* records.holdMarker({ runId, name: "label", args: { name: "x" }, keepOn: [] });
      yield* records.forgetMarker({ runId, name: "claim", args: { item: "a" } });

      expect(yield* records.held(runId, "claim")).toEqual([{ item: "b" }]);
      expect(yield* records.held(runId, "label")).toEqual([{ name: "x" }]);
    }).pipe(Effect.provide(spokeIn(Option.none()))),
  );

  effect("its run's record is what the hub handed over", () =>
    Effect.gen(function* () {
      const records = yield* RunRecords;

      expect(yield* records.run(runId)).toEqual(Option.some(handOver.run));
      expect(yield* records.run(RunId.make("another"))).toEqual(Option.none());
    }).pipe(Effect.provide(spokeIn(Option.none()))),
  );

  effect(
    "a session's token cursor is its own last reading, else state.db's, which it never writes",
    () =>
      Effect.gen(function* () {
        const records = yield* RunRecords;
        const fs = yield* FileSystem.FileSystem;
        const state = (yield* TestState).path;
        const before = yield* fs.readFile(state);

        yield* records.recordTokenUsage({
          runId,
          step: Option.some("implement"),
          adapter: "claude",
          sessionId: "s-2",
          reading: reading("mine"),
        });

        expect(yield* records.cursor("claude", "s-1")).toEqual(Option.some("from-state"));
        expect(yield* records.cursor("claude", "s-2")).toEqual(Option.some("mine"));
        expect(yield* records.cursor("codex", "s-1")).toEqual(Option.none());
        expect(yield* fs.readFile(state)).toEqual(before);
      }).pipe(
        Effect.provide(
          spokeIn(
            Option.some([
              ["claude", "s-1", "from-state"],
              ["claude", "s-2", "older"],
            ]),
          ),
        ),
      ),
  );

  effect("a session's token cursor reads as never read when there's no state.db", () =>
    Effect.gen(function* () {
      expect(yield* (yield* RunRecords).cursor("claude", "s-1")).toEqual(Option.none());
    }).pipe(Effect.provide(spokeIn(Option.none()))),
  );
});
