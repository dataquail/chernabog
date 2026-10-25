import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { chooseSeededWorkUseCase } from "./choose-seeded-work.use-case.ts";

describe("chooseSeededWorkUseCase", () => {
  effect("keeps only the work about what seeding made", () =>
    Effect.gen(function* () {
      const seeded = {
        issues: [{ name: "bug", number: 12 }],
        pullRequests: [{ name: "fix", number: 7, branch: "rehearsal/fix" }],
      };

      expect(
        yield* chooseSeededWorkUseCase(seeded, ["issue-3", "issue-12", "pr-7-review-2", "pr-70"]),
      ).toEqual(["issue-12", "pr-7-review-2"]);
    }),
  );
});
