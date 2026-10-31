import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../test/sqlite.ts";
import { SkipsRepository } from "../domain/ports/repositories/skips.repository.ts";
import { SkipRoot } from "../domain/skip/skip.root.ts";
import { SkipsRepositoryLive } from "../infrastructure/repositories/skips.repository-live.ts";
import { listRecentSkipsHandler } from "./list-recent-skips.handler.ts";

const skip = (reason: string, at: string) =>
  SkipRoot.make({
    repo: "demo",
    persona: Option.none(),
    flow: "review",
    itemKey: Option.none(),
    reason,
    at,
  });

describe("listRecentSkipsHandler", () => {
  effect("lists the latest skips, newest first", () =>
    Effect.gen(function* () {
      const repository = yield* SkipsRepository;
      yield* repository.save(skip("paused", "2026-10-20T00:00:00Z"));
      yield* repository.save(skip("usage gate", "2026-10-22T00:00:00Z"));
      yield* repository.save(skip("quiet hours", "2026-10-21T00:00:00Z"));

      const { skips } = yield* listRecentSkipsHandler({ latest: 2 });

      expect(skips.map((found) => found.reason)).toEqual(["usage gate", "quiet hours"]);
    }).pipe(Effect.provide(SkipsRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void))))),
  );
});
