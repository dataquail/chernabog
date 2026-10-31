import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { effect } from "../../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../../test/sqlite.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunStepsRepository } from "../../domain/ports/repositories/run-steps.repository.ts";
import { RunStepEntity } from "../../domain/run/run-step.entity.ts";
import { RunStepsRepositoryLive } from "./run-steps.repository-live.ts";

const step = (runId: string, name: string, enteredAt: string) =>
  RunStepEntity.make({ runId: RunId.make(runId), step: name, enteredAt });

describe("RunStepsRepositoryLive", () => {
  effect("keeps each step a run enters, in the order it entered them, repeats included", () =>
    Effect.gen(function* () {
      const steps = yield* RunStepsRepository;
      yield* steps.save(step("a", "claim", "2026-10-20T00:00:00.000Z"));
      yield* steps.save(step("b", "claim", "2026-10-20T00:00:01.000Z"));
      yield* steps.save(step("a", "ci", "2026-10-20T00:01:00.000Z"));
      yield* steps.save(step("a", "ci", "2026-10-20T00:01:00.000Z"));

      expect((yield* steps.findAll(RunId.make("a"))).map((found) => found.step)).toEqual([
        "claim",
        "ci",
        "ci",
      ]);
      expect(yield* steps.findAll(RunId.make("c"))).toEqual([]);
    }).pipe(Effect.provide(RunStepsRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void))))),
  );
});
