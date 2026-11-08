import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../../test/sqlite.ts";
import { TokenUsageCursorRoot } from "../../domain/token-usage-cursor/token-usage-cursor.root.ts";
import { TokenUsageCursorSpecifications } from "../../domain/token-usage-cursor/token-usage-cursor.specification.ts";
import { TokenUsageCursorsRepository } from "../../domain/token-usage-cursor/token-usage-cursors.repository.ts";
import { TokenUsageCursorsRepositoryLive } from "./token-usage-cursors.repository-live.ts";

const cursor = (adapter: string, sessionId: string, at: string) =>
  TokenUsageCursorRoot.make({ adapter, sessionId, cursor: at });

describe("TokenUsageCursorsRepositoryLive", () => {
  effect("keeps one cursor per adapter and session, the latest written", () =>
    Effect.gen(function* () {
      const cursors = yield* TokenUsageCursorsRepository;

      const of = (adapter: string, sessionId: string) =>
        cursors.findOne(TokenUsageCursorSpecifications.forSession(adapter, sessionId));

      expect(yield* of("claude", "s1")).toEqual(Option.none());

      yield* cursors.upsertOne(cursor("claude", "s1", "line:10"));
      yield* cursors.upsertOne(cursor("codex", "s1", "offset:3"));
      yield* cursors.upsertOne(cursor("claude", "s1", "line:42"));

      expect(yield* of("claude", "s1")).toEqual(Option.some(cursor("claude", "s1", "line:42")));
      expect(yield* of("codex", "s1")).toEqual(Option.some(cursor("codex", "s1", "offset:3")));
      expect(yield* of("claude", "s2")).toEqual(Option.none());
    }).pipe(
      Effect.provide(TokenUsageCursorsRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void)))),
    ),
  );
});
