import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunFinished } from "../domain/run/run.events.ts";
import {
  fakeEngine,
  WorkflowsClientFake,
} from "../infrastructure/clients/workflows.client-fake.ts";
import { discardRunJournalHandler } from "./discard-run-journal.handler.ts";

const finished = (runId: string) =>
  RunFinished.make({
    eventId: `${runId}:finished`,
    runId: RunId.make(runId),
    status: "cancelled",
    summary: "cancelled by alice",
    finishedAt: "2026-11-25T00:00:00.000Z",
  });

describe("discardRunJournalHandler", () => {
  effect("deletes the ended run's journal, and a repeat deletes nothing twice", () => {
    const engine = fakeEngine();
    engine.journals.push(RunId.make("ended"), RunId.make("other"));

    return Effect.gen(function* () {
      yield* discardRunJournalHandler(finished("ended"));
      yield* discardRunJournalHandler(finished("ended"));

      expect(engine.discarded.map(String)).toEqual(["ended"]);
      expect(engine.journals.map(String)).toEqual(["other"]);
    }).pipe(Effect.provide(WorkflowsClientFake(engine)));
  });
});
