import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { SkipRoot } from "../domain/skip/skip.root.ts";
import { SkipsRepositoryFake } from "../infrastructure/repositories/skips.repository-fake.ts";
import { listRecentSkipsUseCase } from "./list-recent-skips.use-case.ts";

const skip = (reason: string, at: string) =>
  SkipRoot.make({
    repo: "demo",
    persona: Option.none(),
    flow: "review",
    itemKey: Option.none(),
    reason,
    at,
  });

describe("listRecentSkipsUseCase", () => {
  effect("lists the latest skips, newest first", () =>
    Effect.gen(function* () {
      const { skips } = yield* listRecentSkipsUseCase(2);

      expect(skips.map((found) => found.reason)).toEqual(["usage gate", "quiet hours"]);
    }).pipe(
      Effect.provide(
        SkipsRepositoryFake([
          skip("paused", "2026-10-20T00:00:00Z"),
          skip("usage gate", "2026-10-22T00:00:00Z"),
          skip("quiet hours", "2026-10-21T00:00:00Z"),
        ]),
      ),
    ),
  );
});
