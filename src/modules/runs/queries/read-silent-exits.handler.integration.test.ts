import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../test/sqlite.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { RunsRepositoryLive } from "../infrastructure/repositories/runs.repository-live.ts";
import { readSilentExitsHandler } from "./read-silent-exits.handler.ts";

// The nth run of issue-7 (or `fields`' item), started at minute n.
const run = (n: number, fields: Partial<RunRoot> = {}) =>
  RunRoot.make({
    id: RunId.make(`r${n}`),
    coreVersion: "0.6.0",
    repo: "demo",
    persona: Option.some("alice"),
    flow: "implement",
    itemKey: "issue-7",
    itemTitle: Option.none(),
    itemUrl: Option.none(),
    item: Option.none(),
    executionId: Option.none(),
    status: "running",
    currentStep: Option.none(),
    summary: Option.none(),
    startedAt: `2026-11-25T10:0${n}:00.000Z`,
    finishedAt: Option.none(),
    ...fields,
  });

// Ended, with its silent exits in a row, if its spoke said nothing.
const ended = (n: number, status: RunRoot["status"], silentExits?: number) =>
  run(n, {
    status,
    finishedAt: Option.some(`2026-11-25T10:0${n}:30.000Z`),
    silentExits: Option.fromUndefinedOr(silentExits),
  });

const silentBefore = (n: number) =>
  readSilentExitsHandler({ runId: RunId.make(`r${n}`) }).pipe(
    Effect.map((read) => read.silentExits),
  );

const stores = () => RunsRepositoryLive.pipe(Layer.provideMerge(sqliteAfter(Effect.void)));

describe("readSilentExitsHandler", () => {
  effect("is the count the item's latest silent exit recorded, passing over a hub's restart", () =>
    Effect.gen(function* () {
      const runs = yield* RunsRepository;
      yield* runs.upsertOne(ended(1, "interrupted", 1));
      yield* runs.upsertOne(ended(2, "interrupted", 2));
      // A hub's restart interrupted this one: neither counted nor a reset.
      yield* runs.upsertOne(ended(3, "interrupted"));
      yield* runs.upsertOne(run(4));

      expect(yield* silentBefore(4)).toBe(2);
    }).pipe(Effect.provide(stores())),
  );

  effect("is zero after a run of the item that ended any other way", () =>
    Effect.gen(function* () {
      const runs = yield* RunsRepository;
      yield* runs.upsertOne(ended(1, "interrupted", 2));
      yield* runs.upsertOne(ended(2, "ended-at-park"));
      yield* runs.upsertOne(run(3));

      expect(yield* silentBefore(3)).toBe(0);
    }).pipe(Effect.provide(stores())),
  );

  effect(
    "starts again after the run that reached the limit and failed, once a person re-queued it",
    () =>
      Effect.gen(function* () {
        const runs = yield* RunsRepository;
        yield* runs.upsertOne(ended(1, "interrupted", 1));
        yield* runs.upsertOne(ended(2, "interrupted", 2));
        yield* runs.upsertOne(ended(3, "failed", 3));
        yield* runs.upsertOne(run(4));

        expect(yield* silentBefore(4)).toBe(0);
      }).pipe(Effect.provide(stores())),
  );

  effect("counts only runs of the same item, flow and persona, and none started after", () =>
    Effect.gen(function* () {
      const runs = yield* RunsRepository;
      yield* runs.upsertOne(run(1, { ...ended(1, "interrupted", 2), itemKey: "issue-8" }));
      yield* runs.upsertOne(run(2, { ...ended(2, "interrupted", 2), flow: "review" }));
      yield* runs.upsertOne(run(3, { ...ended(3, "interrupted", 2), persona: Option.some("bob") }));
      yield* runs.upsertOne(run(4));
      yield* runs.upsertOne(ended(5, "interrupted", 2));

      expect(yield* silentBefore(4)).toBe(0);
      expect(yield* silentBefore(9)).toBe(0);
    }).pipe(Effect.provide(stores())),
  );
});
