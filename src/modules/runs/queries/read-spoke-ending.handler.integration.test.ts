import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import {
  fakeEngine,
  WorkflowsClientFake,
} from "../infrastructure/clients/workflows.client-fake.ts";
import { readSpokeEndingHandler } from "./read-spoke-ending.handler.ts";

describe("readSpokeEndingHandler", () => {
  const engine = fakeEngine();
  engine.reports.set(RunId.make("a"), [
    { status: "done", summary: "earlier" },
    { status: "failed", summary: "the gate failed" },
  ]);

  effect("is the last ending the run's spoke reported, and none for one that said none", () =>
    Effect.gen(function* () {
      const said = yield* readSpokeEndingHandler({ runId: RunId.make("a") });
      const silent = yield* readSpokeEndingHandler({ runId: RunId.make("b") });

      expect(said.ending).toEqual(Option.some({ status: "failed", summary: "the gate failed" }));
      expect(silent.ending).toEqual(Option.none());
    }).pipe(Effect.provide(WorkflowsClientFake(engine))),
  );
});
