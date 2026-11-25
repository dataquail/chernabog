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
import { forgetSpokeHandler } from "./forget-spoke.handler.ts";

const spoke = (runId: string) =>
  RunSpokeRoot.make({
    runId: RunId.make(runId),
    pid: 42,
    startedAt: Option.none(),
    hubPid: 7,
    hubStartedAt: Option.none(),
    foldedSeq: 0,
    ending: Option.none(),
  });

describe("forgetSpokeHandler", () => {
  effect("forgets only that run's spoke, and one with no record is no error", () =>
    Effect.gen(function* () {
      yield* forgetSpokeHandler({ runId: RunId.make("a") });
      yield* forgetSpokeHandler({ runId: RunId.make("gone") });

      expect(
        (yield* (yield* RunSpokesRepository).findMany(RunSpokeSpecifications.all)).map(
          (one) => one.runId,
        ),
      ).toEqual([RunId.make("b")]);
    }).pipe(
      Effect.provide([RunSpokesRepositoryFake([spoke("a"), spoke("b")]), PassThroughUnitOfWork]),
    ),
  );
});
