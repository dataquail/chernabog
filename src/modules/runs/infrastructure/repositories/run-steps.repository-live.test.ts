import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { effect } from "../../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../../test/sqlite.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { NodeRef } from "../../domain/plan/node-ref.value-object.ts";
import { RunStepEntity } from "../../domain/run/run-step.entity.ts";
import { RunStepSpecifications } from "../../domain/run/run-step.specification.ts";
import { RunStepsRepository } from "../../domain/run/run-steps.repository.ts";
import { RunStepsRepositoryLive } from "./run-steps.repository-live.ts";

const step = (runId: string, name: string, enteredAt: string) =>
  RunStepEntity.make({
    runId: RunId.make(runId),
    step: name,
    node: Option.none(),
    enteredAt,
    finishedAt: Option.none(),
    outcome: Option.none(),
  });

describe("RunStepsRepositoryLive", () => {
  effect("keeps each step a run enters, in the order it entered them, repeats included", () =>
    Effect.gen(function* () {
      const steps = yield* RunStepsRepository;
      yield* steps.insertOne(step("a", "claim", "2026-10-20T00:00:00.000Z"));
      yield* steps.insertOne(step("b", "claim", "2026-10-20T00:00:01.000Z"));
      yield* steps.insertOne(step("a", "ci", "2026-10-20T00:01:00.000Z"));
      yield* steps.insertOne(step("a", "ci", "2026-10-20T00:01:00.000Z"));

      expect(
        (yield* steps.findMany(RunStepSpecifications.forRun(RunId.make("a")))).map(
          (found) => found.step,
        ),
      ).toEqual(["claim", "ci", "ci"]);
      expect(yield* steps.findMany(RunStepSpecifications.forRun(RunId.make("c")))).toEqual([]);
    }).pipe(Effect.provide(RunStepsRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void))))),
  );

  effect("keeps the node a step ran at, with its round and lane", () =>
    Effect.gen(function* () {
      const steps = yield* RunStepsRepository;

      const atCi = RunStepEntity.make({
        ...step("a", "ci-2#task-10", "2026-10-20T00:00:00.000Z"),
        node: Option.some(NodeRef.make({ id: "ci", round: 2, lane: "task-10" })),
      });

      const atClaim = RunStepEntity.make({
        ...step("a", "claim-epic", "2026-10-20T00:00:01.000Z"),
        node: Option.some(NodeRef.make({ id: "claimed" })),
      });

      yield* steps.insertOne(atCi);
      yield* steps.insertOne(atClaim);
      yield* steps.insertOne(step("a", "release", "2026-10-20T00:00:02.000Z"));

      expect(
        (yield* steps.findMany(RunStepSpecifications.forRun(RunId.make("a")))).map(
          (found) => found.node,
        ),
      ).toEqual([atCi.node, atClaim.node, Option.none()]);
    }).pipe(Effect.provide(RunStepsRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void))))),
  );

  // A database from before steps kept their nodes, as a run parked then left it.
  const before = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE om_steps (run_id TEXT NOT NULL, step TEXT NOT NULL, entered_at TEXT NOT NULL, finished_at TEXT, outcome TEXT)`;
    yield* sql`INSERT INTO om_steps (run_id, step, entered_at) VALUES ('a', 'review', '2026-10-20T00:00:00.000Z')`;
  });

  effect(
    "reads a step from before steps kept their nodes as at none, and keeps new ones' nodes",
    () =>
      Effect.gen(function* () {
        const steps = yield* RunStepsRepository;

        const atLand = RunStepEntity.make({
          ...step("a", "merge", "2026-10-20T00:01:00.000Z"),
          node: Option.some(NodeRef.make({ id: "land" })),
        });

        yield* steps.insertOne(atLand);

        expect(
          (yield* steps.findMany(RunStepSpecifications.forRun(RunId.make("a")))).map((found) => [
            found.step,
            found.node,
          ]),
        ).toEqual([
          ["review", Option.none()],
          ["merge", atLand.node],
        ]);
      }).pipe(Effect.provide(RunStepsRepositoryLive.pipe(Layer.provide(sqliteAfter(before))))),
  );
});
