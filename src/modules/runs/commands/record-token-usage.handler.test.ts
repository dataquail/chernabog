import { makeUnitOfWork } from "@effect-server-utils/unit-of-work";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { DispatchedEvents, RecordedEvents } from "../../../../test/events.ts";
import { sqliteAfter } from "../../../../test/sqlite.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { type ModelUsage } from "../domain/token-usage/model-usage.value-object.ts";
import { TokenUsageRecorded } from "../domain/token-usage/token-usage.events.ts";
import { TokenUsageSpecifications } from "../domain/token-usage/token-usage.specification.ts";
import { TokenUsagesRepository } from "../domain/token-usage/token-usages.repository.ts";
import { TokenUsageCursorRoot } from "../domain/token-usage-cursor/token-usage-cursor.root.ts";
import { TokenUsageCursorSpecifications } from "../domain/token-usage-cursor/token-usage-cursor.specification.ts";
import { TokenUsageCursorsRepository } from "../domain/token-usage-cursor/token-usage-cursors.repository.ts";
import { StateDbTransactionDriverLive } from "../infrastructure/repositories/state-db.transaction-driver-live.ts";
import { TokenUsageCursorsRepositoryFake } from "../infrastructure/repositories/token-usage-cursors.repository-fake.ts";
import { TokenUsagesRepositoryFake } from "../infrastructure/repositories/token-usages.repository-fake.ts";
import { TokenUsagesRepositoryLive } from "../infrastructure/repositories/token-usages.repository-live.ts";
import { recordTokenUsageHandler } from "./record-token-usage.handler.ts";

const a = RunId.make("a");

const usage = (model: string, input: number): ModelUsage => ({
  model,
  input: Option.some(input),
  output: Option.some(10),
  cacheRead: Option.some(500),
  cacheWrite: Option.none(),
});

const call = {
  runId: a,
  step: Option.some("implement"),
  adapter: "claude",
  sessionId: "session-1",
};

const cursorOf = (adapter: string, sessionId: string) =>
  TokenUsageCursorsRepository.use((cursors) =>
    cursors.findOne(TokenUsageCursorSpecifications.forSession(adapter, sessionId)),
  ).pipe(Effect.map(Option.map((found) => found.cursor)));

const rowsOf = (runId: RunId) =>
  TokenUsagesRepository.use((usages) => usages.findMany(TokenUsageSpecifications.forRun(runId)));

const fakes = Layer.mergeAll(
  RecordedEvents,
  TokenUsagesRepositoryFake([]),
  TokenUsageCursorsRepositoryFake([
    TokenUsageCursorRoot.make({ adapter: "claude", sessionId: "session-1", cursor: "line:3" }),
  ]),
);

describe("recordTokenUsageHandler", () => {
  effect("writes a row per model, moves the session's cursor, and says so", () =>
    Effect.gen(function* () {
      yield* recordTokenUsageHandler({
        ...call,
        reading: Option.some({
          records: [usage("opus", 100), usage("haiku", 20)],
          cursor: "line:9",
        }),
      });

      const rows = yield* rowsOf(a);

      expect(rows).toEqual([
        expect.objectContaining({
          model: Option.some("opus"),
          input: Option.some(100),
          cacheWrite: Option.none(),
          reported: true,
          step: Option.some("implement"),
        }),
        expect.objectContaining({
          model: Option.some("haiku"),
          input: Option.some(20),
          reported: true,
        }),
      ]);
      expect(yield* cursorOf("claude", "session-1")).toEqual(Option.some("line:9"));

      const recordedAt = rows[0]?.recordedAt ?? "";

      expect(yield* DispatchedEvents).toEqual([
        TokenUsageRecorded.make({
          eventId: `a:usage:claude:session-1:${recordedAt}`,
          ...call,
          reported: true,
          recordedAt,
        }),
      ]);
    }).pipe(Effect.provide(fakes)),
  );

  effect("a call its adapter couldn't read writes one unreported row and keeps the cursor", () =>
    Effect.gen(function* () {
      yield* recordTokenUsageHandler({ ...call, step: Option.none(), reading: Option.none() });

      const rows = yield* rowsOf(a);

      expect(rows).toEqual([
        expect.objectContaining({
          reported: false,
          model: Option.none(),
          input: Option.none(),
          step: Option.none(),
        }),
      ]);
      expect(yield* cursorOf("claude", "session-1")).toEqual(Option.some("line:3"));
      expect((yield* DispatchedEvents).map((event) => event._tag)).toEqual(["TokenUsageRecorded"]);
    }).pipe(Effect.provide(fakes)),
  );

  // A cursor that can't be written: the rows written before it must not stay.
  const brokenCursors = Layer.succeed(
    TokenUsageCursorsRepository,
    TokenUsageCursorsRepository.of({
      findOne: () => Effect.succeedNone,
      upsertOne: () => Effect.die("disk full"),
    }),
  );

  const stateDb = Layer.mergeAll(
    RecordedEvents,
    TokenUsagesRepositoryLive,
    brokenCursors,
    // In place of the pass-through one RecordedEvents brings: a later layer wins.
    makeUnitOfWork().pipe(Layer.provide(StateDbTransactionDriverLive)),
  ).pipe(Layer.provideMerge(sqliteAfter(Effect.void)));

  effect("the rows and the cursor commit together, or neither does", () =>
    Effect.gen(function* () {
      const ended = yield* recordTokenUsageHandler({
        ...call,
        reading: Option.some({ records: [usage("opus", 100)], cursor: "line:9" }),
      }).pipe(
        Effect.as("recorded"),
        Effect.catchDefect(() => Effect.succeed("died")),
      );

      expect(ended).toBe("died");
      expect(yield* rowsOf(a)).toEqual([]);
      expect(yield* DispatchedEvents).toEqual([]);
    }).pipe(Effect.provide(stateDb)),
  );
});
