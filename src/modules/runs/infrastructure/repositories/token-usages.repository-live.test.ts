import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../../test/sqlite.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { TokenUsageRoot } from "../../domain/token-usage/token-usage.root.ts";
import { TokenUsageSpecifications } from "../../domain/token-usage/token-usage.specification.ts";
import { TokenUsagesRepository } from "../../domain/token-usage/token-usages.repository.ts";
import { TokenUsagesRepositoryLive } from "./token-usages.repository-live.ts";

const AT = "2026-11-08T00:00:00.000Z";

const reported = (runId: string, model: string) =>
  TokenUsageRoot.make({
    runId: RunId.make(runId),
    step: Option.some("implement"),
    adapter: "claude",
    sessionId: "session-1",
    model: Option.some(model),
    input: Option.some(120),
    output: Option.some(40),
    cacheRead: Option.some(9000),
    cacheWrite: Option.none(),
    reported: true,
    recordedAt: AT,
  });

const unreported = (runId: string) =>
  TokenUsageRoot.make({
    runId: RunId.make(runId),
    step: Option.none(),
    adapter: "rehearsal",
    sessionId: "session-2",
    model: Option.none(),
    input: Option.none(),
    output: Option.none(),
    cacheRead: Option.none(),
    cacheWrite: Option.none(),
    reported: false,
    recordedAt: AT,
  });

describe("TokenUsagesRepositoryLive", () => {
  effect("keeps each call's rows, by run, in the order they were recorded", () =>
    Effect.gen(function* () {
      const usages = yield* TokenUsagesRepository;
      yield* usages.insertMany([reported("a", "opus"), reported("a", "haiku")]);
      yield* usages.insertMany([reported("b", "opus")]);
      yield* usages.insertMany([unreported("a")]);
      yield* usages.insertMany([]);

      expect(yield* usages.findMany(TokenUsageSpecifications.forRun(RunId.make("a")))).toEqual([
        reported("a", "opus"),
        reported("a", "haiku"),
        unreported("a"),
      ]);
      expect(yield* usages.findMany(TokenUsageSpecifications.forRun(RunId.make("c")))).toEqual([]);
    }).pipe(
      Effect.provide(TokenUsagesRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void)))),
    ),
  );
});
