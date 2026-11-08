import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../test/sqlite.ts";
import { TokenUsageCursorRoot } from "../domain/token-usage-cursor/token-usage-cursor.root.ts";
import { TokenUsageCursorsRepository } from "../domain/token-usage-cursor/token-usage-cursors.repository.ts";
import { TokenUsageCursorsRepositoryLive } from "../infrastructure/repositories/token-usage-cursors.repository-live.ts";
import { readTokenUsageCursorHandler } from "./read-token-usage-cursor.handler.ts";

const stores = TokenUsageCursorsRepositoryLive.pipe(Layer.provideMerge(sqliteAfter(Effect.void)));

describe("readTokenUsageCursorHandler", () => {
  effect("reads the cursor an adapter's session was left at, none for one never read", () =>
    Effect.gen(function* () {
      yield* (yield* TokenUsageCursorsRepository).upsertOne(
        TokenUsageCursorRoot.make({ adapter: "claude", sessionId: "s1", cursor: "line:7" }),
      );

      expect(
        (yield* readTokenUsageCursorHandler({ adapter: "claude", sessionId: "s1" })).cursor,
      ).toEqual(Option.some("line:7"));
      expect(
        (yield* readTokenUsageCursorHandler({ adapter: "codex", sessionId: "s1" })).cursor,
      ).toEqual(Option.none());
    }).pipe(Effect.provide(stores)),
  );
});
