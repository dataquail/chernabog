import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { effect } from "../../../../test/effect-test.ts";
import { RecordedEvents } from "../../../../test/events.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import {
  fakeEngine,
  WorkflowsClientFake,
} from "../infrastructure/clients/workflows.client-fake.ts";
import { reportRunEndedHandler } from "./report-run-ended.handler.ts";

describe("reportRunEndedHandler", () => {
  const engine = fakeEngine();

  effect("reports the run's ending into its journal, after any it reported before", () =>
    Effect.gen(function* () {
      yield* reportRunEndedHandler({
        runId: RunId.make("a"),
        ending: { status: "ended-at-park", summary: "waits on review" },
      });
      yield* reportRunEndedHandler({
        runId: RunId.make("a"),
        ending: { status: "done", summary: "handed off" },
      });

      expect(engine.reports.get(RunId.make("a"))).toEqual([
        { status: "ended-at-park", summary: "waits on review" },
        { status: "done", summary: "handed off" },
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(RecordedEvents, WorkflowsClientFake(engine)))),
  );
});
