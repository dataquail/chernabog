import { defineFlow, RunLog } from "@chernabog/core";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { item, makeFake, repo, runToEnd, runUntil } from "../../../../../test/sdk-fakes.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { WorkflowsClient } from "../../domain/ports/clients/workflows.client.ts";
import { flowHandle } from "../runtime/engine.ts";
import { RunJournals } from "../runtime/journals.ts";

// A flow whose workflow logs a line and ends with what its item says.
const flow = defineFlow({
  trigger: Effect.succeed([]),
  workflow: (work) =>
    RunLog.use((log) => log.log(`working on ${work.key}`)).pipe(Effect.as(`did ${work.key}`)),
});

describe("WorkflowsClientLive", () => {
  effect("executes a run's workflow in the engine, and polls how it ended", () =>
    Effect.gen(function* () {
      const finished = yield* runToEnd(
        flowHandle(repo, "demo", flow),
        makeFake("approve"),
        item("pr-1"),
      );

      expect(finished.status).toBe("done");
      expect(finished.summary).toEqual(Option.some("did pr-1"));
    }),
  );

  effect("says the execution id a run's workflow runs under, from the run alone", () =>
    Effect.gen(function* () {
      const handle = flowHandle(repo, "demo", flow);
      const seen: Array<boolean> = [];

      yield* runUntil(handle, makeFake("approve"), item("pr-1"), (run) =>
        Effect.gen(function* () {
          const expected = yield* WorkflowsClient.use((workflows) =>
            workflows.executionIdOf(
              { repo: run.repo, flow: run.flow, persona: run.persona },
              run.id,
              item("pr-1"),
            ),
          );

          seen.push(Option.contains(run.executionId, expected));

          return true;
        }),
      );

      expect(seen).toEqual([true]);
    }),
  );

  effect("keeps a spoke's reported ending in its run's journal, and reads back the last", () =>
    Effect.gen(function* () {
      const handle = flowHandle(repo, "demo", flow);
      const read: Array<unknown> = [];

      yield* runUntil(handle, makeFake("approve"), item("pr-1"), (run) =>
        WorkflowsClient.use((workflows) =>
          Effect.gen(function* () {
            read.push(yield* workflows.reportedEnding(run.id));
            yield* workflows.reportEnded(run.id, { status: "ended-at-park", summary: "parked" });
            yield* workflows.reportEnded(run.id, { status: "done", summary: "did pr-1" });
            read.push(yield* workflows.reportedEnding(run.id));
            yield* workflows.reportEnded(RunId.make("no-journal"), {
              status: "done",
              summary: "late",
            });
            read.push(yield* workflows.reportedEnding(RunId.make("no-journal")));

            return true;
          }),
        ),
      );

      expect(read).toEqual([
        Option.none(),
        Option.some({ status: "done", summary: "did pr-1" }),
        Option.none(),
      ]);
    }),
  );

  effect("reads back a spoke's reports in its run's journal, in order, after the one asked", () =>
    Effect.gen(function* () {
      const handle = flowHandle(repo, "demo", flow);
      const read: Array<unknown> = [];

      yield* runUntil(handle, makeFake("approve"), item("pr-1"), (run) =>
        Effect.gen(function* () {
          const journals = yield* RunJournals;
          const workflows = yield* WorkflowsClient;
          yield* journals.append(run.id, "EnterStepCommand", '{"step":"claim"}');
          yield* journals.append(run.id, "FinishStepCommand", '{"step":"claim"}');

          const reports = (after: number) =>
            Effect.map(workflows.reports(run.id, after), (found) =>
              found.map((report) => [report.seq, report.tag, report.payload]),
            );

          read.push(yield* reports(0), yield* reports(1));
          read.push(yield* workflows.reports(RunId.make("no-journal"), 0));

          return true;
        }),
      );

      expect(read).toEqual([
        [
          [1, "EnterStepCommand", '{"step":"claim"}'],
          [2, "FinishStepCommand", '{"step":"claim"}'],
        ],
        [[2, "FinishStepCommand", '{"step":"claim"}']],
        [],
      ]);
    }),
  );
});
