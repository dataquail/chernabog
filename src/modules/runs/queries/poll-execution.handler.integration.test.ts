import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import {
  fakeEngine,
  WorkflowsClientFake,
} from "../infrastructure/clients/workflows.client-fake.ts";
import { pollExecutionHandler } from "./poll-execution.handler.ts";

const review = { repo: "demo", flow: "review", persona: Option.some("bob") };

describe("pollExecutionHandler", () => {
  const engine = fakeEngine();
  engine.outcomes["execution-ended"] = { status: "done", summary: "handed off" };

  effect("is how the run's execution ended, and none while it runs", () =>
    Effect.gen(function* () {
      const ended = yield* pollExecutionHandler({
        runId: RunId.make("ended"),
        executionId: "execution-ended",
        flow: review,
      });

      const running = yield* pollExecutionHandler({
        runId: RunId.make("running"),
        executionId: "execution-running",
        flow: review,
      });

      expect(ended.ended).toEqual(Option.some({ status: "done", summary: "handed off" }));
      expect(running.ended).toEqual(Option.none());
    }).pipe(Effect.provide(WorkflowsClientFake(engine))),
  );
});
