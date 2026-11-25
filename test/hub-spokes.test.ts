import { describe, expect, test } from "bun:test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  foldSpoke,
  ReportFold,
  reportFold,
  spokeArgs,
  spokeEnvironment,
  type SpokeHandOver,
} from "../src/interface/daemon/spokes.server.ts";
import { RunId } from "../src/kernel/run-id.id.ts";
import {
  RunView,
  type SpokeReport,
  SpokeReportCommand,
  spokeReportPayloadJson,
} from "../src/modules/runs/runs.platform.ts";
import { effect } from "./effect-test.ts";

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
    expect(spokeArgs(handOver(), "/home/spokes/3f2a.hand-over.json")).toEqual([
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
    ]);
  });

  test("names no persona for the implicit one, and no tree for a working copy's", () => {
    const args = spokeArgs(
      handOver({ persona: Option.none(), tree: Option.none() }),
      "/home/spokes/3f2a.hand-over.json",
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
