import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../../test/sqlite.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunSpokeRoot } from "../../domain/run-spoke/run-spoke.root.ts";
import { RunSpokeSpecifications } from "../../domain/run-spoke/run-spoke.specification.ts";
import { RunSpokesRepository } from "../../domain/run-spoke/run-spokes.repository.ts";
import { RunSpokesRepositoryLive } from "./run-spokes.repository-live.ts";

const spoke = (runId: string, pid: number) =>
  RunSpokeRoot.make({
    runId: RunId.make(runId),
    pid,
    startedAt: Option.some("Wed Nov 25 10:00:00 2026"),
    hubPid: 7,
    hubStartedAt: Option.none(),
    foldedSeq: 0,
    ending: Option.none(),
  });

describe("RunSpokesRepositoryLive", () => {
  effect("keeps one record a run, with its fold position and intended ending, and deletes it", () =>
    Effect.gen(function* () {
      const spokes = yield* RunSpokesRepository;
      yield* spokes.upsertOne(spoke("a", 10));
      yield* spokes.upsertOne(spoke("b", 11));

      const ending = {
        by: "chernabog",
        closeSessions: true,
        endAs: Option.some({ ending: "failed" as const, reason: "past its idle bound" }),
      };

      yield* spokes.upsertOne(
        RunSpokeRoot.make({ ...spoke("a", 10), foldedSeq: 4, ending: Option.some(ending) }),
      );

      const a = yield* spokes.findOne(RunSpokeSpecifications.forRun(RunId.make("a")));

      expect(Option.map(a, (found) => [found.foldedSeq, found.ending, found.startedAt])).toEqual(
        Option.some([4, Option.some(ending), Option.some("Wed Nov 25 10:00:00 2026")]),
      );
      expect(
        Option.map(
          yield* spokes.findOne(RunSpokeSpecifications.forRun(RunId.make("b"))),
          (found) => found.hubStartedAt,
        ),
      ).toEqual(Option.some(Option.none()));
      expect((yield* spokes.findMany(RunSpokeSpecifications.all)).length).toBe(2);

      yield* spokes.deleteOne(spoke("a", 10));

      expect(
        (yield* spokes.findMany(RunSpokeSpecifications.all)).map((found) => found.runId),
      ).toEqual([RunId.make("b")]);
      expect(yield* spokes.findOne(RunSpokeSpecifications.forRun(RunId.make("a")))).toEqual(
        Option.none(),
      );
    }).pipe(Effect.provide(RunSpokesRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void))))),
  );
});
