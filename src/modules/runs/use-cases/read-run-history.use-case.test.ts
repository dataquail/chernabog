import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunStepRoot } from "../domain/run-step/run-step.root.ts";
import { RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
import { RunStepsRepositoryFake } from "../infrastructure/repositories/run-steps.repository-fake.ts";
import { RunWaitsRepositoryFake } from "../infrastructure/repositories/run-waits.repository-fake.ts";
import { readRunHistoryUseCase } from "./read-run-history.use-case.ts";

const a = RunId.make("a");

const step = (runId: RunId, name: string, enteredAt: string) =>
  RunStepRoot.make({ runId, step: name, enteredAt });

describe("readRunHistoryUseCase", () => {
  effect("reads a run's steps in order, and the signals it's parked on", () =>
    Effect.gen(function* () {
      const history = yield* readRunHistoryUseCase(a);

      expect(history.steps.map((found) => found.step)).toEqual(["claim", "wait-for-push"]);
      expect(history.waits.map((wait) => [wait.signal, wait.parkedAt])).toEqual([
        ["pushed", Option.some("2026-10-20T00:02:00.000Z")],
      ]);
      expect(yield* readRunHistoryUseCase(RunId.make("old"))).toMatchObject({
        steps: [],
        waits: [],
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          RunStepsRepositoryFake([
            step(a, "claim", "2026-10-20T00:00:00.000Z"),
            step(RunId.make("b"), "claim", "2026-10-20T00:00:30.000Z"),
            step(a, "wait-for-push", "2026-10-20T00:01:00.000Z"),
          ]),
          RunWaitsRepositoryFake([
            RunWaitRoot.make({
              runId: a,
              signal: "pushed",
              deferred: "d",
              token: "t",
              parkedAt: Option.some("2026-10-20T00:02:00.000Z"),
            }),
          ]),
        ),
      ),
    ),
  );
});
