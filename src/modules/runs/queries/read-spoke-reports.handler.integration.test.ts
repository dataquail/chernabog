import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import {
  fakeEngine,
  WorkflowsClientFake,
} from "../infrastructure/clients/workflows.client-fake.ts";
import { readSpokeReportsHandler } from "./read-spoke-reports.handler.ts";

describe("readSpokeReportsHandler", () => {
  const engine = fakeEngine();

  const report = (seq: number, tag: string) => ({
    seq,
    at: "2026-11-25T00:00:00Z",
    tag,
    payload: "{}",
  });

  engine.journalReports.set(RunId.make("a"), [
    report(1, "EnterStepCommand"),
    report(2, "FinishStepCommand"),
    report(3, "RunEnded"),
  ]);

  effect("is the run's reports after the one the hub last folded, in order", () =>
    Effect.gen(function* () {
      const all = yield* readSpokeReportsHandler({ runId: RunId.make("a"), after: 0 });
      const rest = yield* readSpokeReportsHandler({ runId: RunId.make("a"), after: 1 });
      const none = yield* readSpokeReportsHandler({ runId: RunId.make("b"), after: 0 });

      expect(all.reports.map((one) => one.seq)).toEqual([1, 2, 3]);
      expect(rest.reports.map((one) => one.tag)).toEqual(["FinishStepCommand", "RunEnded"]);
      expect(none.reports).toEqual([]);
    }).pipe(Effect.provide(WorkflowsClientFake(engine))),
  );
});
