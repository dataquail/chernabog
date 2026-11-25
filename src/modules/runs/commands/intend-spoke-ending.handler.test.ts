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
import { intendSpokeEndingHandler } from "./intend-spoke-ending.handler.ts";

const runId = RunId.make("a");

const spoke = RunSpokeRoot.make({
  runId,
  pid: 42,
  startedAt: Option.none(),
  hubPid: 7,
  hubStartedAt: Option.none(),
  foldedSeq: 2,
  ending: Option.none(),
});

const cancel = { by: "alice", closeSessions: true, endAs: Option.none() };

const lost = {
  by: "chernabog",
  closeSessions: false,
  endAs: Option.some({ ending: "lost" as const, reason: "bob took it over" }),
};

const endings = RunSpokesRepository.use((spokes) =>
  spokes.findMany(RunSpokeSpecifications.all),
).pipe(Effect.map((found) => found.map((one) => one.ending)));

describe("intendSpokeEndingHandler", () => {
  effect("records the first ending meant for a spoke, which a second leaves as it is", () =>
    Effect.gen(function* () {
      yield* intendSpokeEndingHandler({ runId, ending: cancel });
      yield* intendSpokeEndingHandler({ runId, ending: lost });

      expect(yield* endings).toEqual([Option.some(cancel)]);
    }).pipe(Effect.provide([RunSpokesRepositoryFake([spoke]), PassThroughUnitOfWork])),
  );

  effect("records nothing for a run whose spoke has no record", () =>
    Effect.gen(function* () {
      yield* intendSpokeEndingHandler({ runId, ending: cancel });

      expect(yield* endings).toEqual([]);
    }).pipe(Effect.provide([RunSpokesRepositoryFake([]), PassThroughUnitOfWork])),
  );
});
