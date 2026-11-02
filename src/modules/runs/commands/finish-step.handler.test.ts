import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { DispatchedEvents, RecordedEvents } from "../../../../test/events.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunStepEntity } from "../domain/run/run-step.entity.ts";
import { RunStepSpecifications } from "../domain/run/run-step.specification.ts";
import { RunStepsRepository } from "../domain/run/run-steps.repository.ts";
import { RunStepsRepositoryFake } from "../infrastructure/repositories/run-steps.repository-fake.ts";
import { finishStepHandler } from "./finish-step.handler.ts";

const a = RunId.make("a");

const entered = (step: string, enteredAt: string, ended: Option.Option<string> = Option.none()) =>
  RunStepEntity.make({
    runId: a,
    step,
    enteredAt,
    finishedAt: ended,
    outcome: Option.as(ended, "ok"),
  });

const steps = (recorded: ReadonlyArray<RunStepEntity>) =>
  Layer.mergeAll(RecordedEvents, RunStepsRepositoryFake(recorded));

const ends = Effect.gen(function* () {
  const found = yield* (yield* RunStepsRepository).findMany(RunStepSpecifications.forRun(a));

  return found.map((step) => [step.step, Option.isSome(step.finishedAt), step.outcome]);
});

const eventsOf = (events: ReadonlyArray<{ readonly _tag: string; readonly eventId?: unknown }>) =>
  events.map((event) => [event._tag, event.eventId]);

describe("finishStepHandler", () => {
  effect("ends the step a run is in with how it ended, and says so once", () =>
    Effect.gen(function* () {
      yield* finishStepHandler({ runId: a, step: "ci", outcome: "failed" });
      yield* finishStepHandler({ runId: a, step: "ci", outcome: "ok" });

      expect(yield* ends).toEqual([
        ["claim", true, Option.some("ok")],
        ["ci", true, Option.some("failed")],
      ]);
      expect(eventsOf(yield* DispatchedEvents)).toEqual([
        ["RunFinishedStep", "a:step-finished:ci"],
      ]);
      expect((yield* DispatchedEvents)[0]).toMatchObject({
        runId: a,
        step: "ci",
        outcome: "failed",
      });
    }).pipe(
      Effect.provide(
        steps([
          entered("claim", "2026-10-20T00:00:01.000Z", Option.some("2026-10-20T00:00:02.000Z")),
          entered("ci", "2026-10-20T00:00:03.000Z"),
        ]),
      ),
    ),
  );

  effect("a step entered again, as after a restart, ends its latest entry alone", () =>
    Effect.gen(function* () {
      yield* finishStepHandler({ runId: a, step: "ci", outcome: "ok" });

      expect(yield* ends).toEqual([
        ["ci", false, Option.none()],
        ["ci", true, Option.some("ok")],
      ]);
    }).pipe(
      Effect.provide(
        steps([
          entered("ci", "2026-10-20T00:00:03.000Z"),
          entered("ci", "2026-10-20T00:09:00.000Z"),
        ]),
      ),
    ),
  );

  effect("a step the run never entered, or ended already, changes nothing and tells no one", () =>
    Effect.gen(function* () {
      yield* finishStepHandler({ runId: a, step: "never", outcome: "ok" });
      yield* finishStepHandler({ runId: a, step: "claim", outcome: "failed" });

      expect(yield* ends).toEqual([["claim", true, Option.some("ok")]]);
      expect(yield* DispatchedEvents).toEqual([]);
    }).pipe(
      Effect.provide(
        steps([
          entered("claim", "2026-10-20T00:00:01.000Z", Option.some("2026-10-20T00:00:02.000Z")),
        ]),
      ),
    ),
  );
});
