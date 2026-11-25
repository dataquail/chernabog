import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunSpokeSpecifications } from "../domain/run-spoke/run-spoke.specification.ts";
import { RunSpokesRepository } from "../domain/run-spoke/run-spokes.repository.ts";
import { RunSpokesRepositoryFake } from "../infrastructure/repositories/run-spokes.repository-fake.ts";
import { recordSpokeHandler } from "./record-spoke.handler.ts";

const runId = RunId.make("a");

describe("recordSpokeHandler", () => {
  effect("records a run's spoke with nothing folded and no ending meant, once a run", () =>
    Effect.gen(function* () {
      const spoke = {
        runId,
        pid: 42,
        startedAt: Option.some("Wed Nov 25 10:00:00 2026"),
        hubPid: 7,
        hubStartedAt: Option.some("Wed Nov 25 09:00:00 2026"),
      };

      yield* recordSpokeHandler({ ...spoke, pid: 41 });
      yield* recordSpokeHandler(spoke);

      const found = yield* (yield* RunSpokesRepository).findMany(RunSpokeSpecifications.all);

      expect(found.map((one) => [one.runId, one.pid, one.foldedSeq, one.ending])).toEqual([
        [runId, 42, 0, Option.none()],
      ]);
    }).pipe(Effect.provide([RunSpokesRepositoryFake([]), PassThroughUnitOfWork])),
  );
});
