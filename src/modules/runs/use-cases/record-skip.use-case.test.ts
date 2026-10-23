import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { SkipsRepositoryFake } from "../infrastructure/repositories/skips.repository-fake.ts";
import { listRecentSkipsUseCase } from "./list-recent-skips.use-case.ts";
import { recordSkipUseCase } from "./record-skip.use-case.ts";

describe("recordSkipUseCase", () => {
  effect("records why the tick skipped, and when", () =>
    Effect.gen(function* () {
      const recorded = yield* recordSkipUseCase({
        repo: "demo",
        persona: Option.some("bob"),
        flow: "review",
        itemKey: Option.none(),
        reason: "paused",
      });

      expect(recorded.at.length > 0).toBe(true);
      expect((yield* listRecentSkipsUseCase(5)).skips).toEqual([recorded]);
    }).pipe(Effect.provide(SkipsRepositoryFake([]))),
  );
});
