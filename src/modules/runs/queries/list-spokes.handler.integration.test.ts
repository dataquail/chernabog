import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../test/sqlite.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunSpokeRoot } from "../domain/run-spoke/run-spoke.root.ts";
import { RunSpokesRepository } from "../domain/run-spoke/run-spokes.repository.ts";
import { RunSpokesRepositoryLive } from "../infrastructure/repositories/run-spokes.repository-live.ts";
import { listSpokesHandler } from "./list-spokes.handler.ts";

const stores = RunSpokesRepositoryLive.pipe(Layer.provideMerge(sqliteAfter(Effect.void)));

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

describe("listSpokesHandler", () => {
  effect("lists every recorded spoke, with its fold position and the ending meant for it", () =>
    Effect.gen(function* () {
      const bound = {
        by: "chernabog",
        closeSessions: true,
        endAs: Option.some({ ending: "failed" as const, reason: "past its idle bound" }),
      };

      const spokes = yield* RunSpokesRepository;
      yield* spokes.upsertOne(spoke("a", 10));
      yield* spokes.upsertOne(
        RunSpokeRoot.make({ ...spoke("b", 11), foldedSeq: 5, ending: Option.some(bound) }),
      );

      const listed = (yield* listSpokesHandler()).spokes;

      expect(listed.map((one) => [one.runId, one.pid, one.foldedSeq])).toEqual([
        [RunId.make("a"), 10, 0],
        [RunId.make("b"), 11, 5],
      ]);
      expect(listed.map((one) => one.startedAt)).toEqual([
        Option.some("Wed Nov 25 10:00:00 2026"),
        Option.some("Wed Nov 25 10:00:00 2026"),
      ]);
      expect(listed.map((one) => one.ending)).toEqual([Option.none(), Option.some(bound)]);
    }).pipe(Effect.provide(stores)),
  );
});
