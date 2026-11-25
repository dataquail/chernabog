import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunSpokeRoot } from "../domain/run-spoke/run-spoke.root.ts";
import { RunSpokeSpecifications } from "../domain/run-spoke/run-spoke.specification.ts";
import { RunSpokesRepository } from "../domain/run-spoke/run-spokes.repository.ts";
import { RunSpokesRepositoryFake } from "../infrastructure/repositories/run-spokes.repository-fake.ts";
import { advanceSpokeFoldHandler } from "./advance-spoke-fold.handler.ts";

const runId = RunId.make("a");

const spoke = RunSpokeRoot.make({
  runId,
  pid: 42,
  startedAt: Option.none(),
  hubPid: 7,
  hubStartedAt: Option.none(),
  foldedSeq: 0,
  ending: Option.none(),
});

const positions = RunSpokesRepository.use((spokes) =>
  spokes.findMany(RunSpokeSpecifications.all),
).pipe(Effect.map((found) => found.map((one) => [one.runId, one.foldedSeq])));

describe("advanceSpokeFoldHandler", () => {
  effect("moves a spoke's fold position on, never back", () =>
    Effect.gen(function* () {
      yield* advanceSpokeFoldHandler({ runId, seq: 3 });
      yield* advanceSpokeFoldHandler({ runId, seq: 2 });

      expect(yield* positions).toEqual([[runId, 3]]);
    }).pipe(Effect.provide([RunSpokesRepositoryFake([spoke]), PassThroughUnitOfWork])),
  );

  effect("records nothing for a run whose spoke has no record", () =>
    Effect.gen(function* () {
      yield* advanceSpokeFoldHandler({ runId: RunId.make("ended"), seq: 3 });

      expect(yield* positions).toEqual([]);
    }).pipe(Effect.provide([RunSpokesRepositoryFake([]), PassThroughUnitOfWork])),
  );
});
