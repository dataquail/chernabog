import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { scratchRepoFake } from "../infrastructure/clients/scratch-repo.client-fake.ts";
import { cleanUpScenarioHandler } from "./clean-up-scenario.handler.ts";

const seeded = {
  issues: [{ name: "bug", number: 12 }],
  pullRequests: [
    { name: "fix", number: 7, branch: "rehearsal/fix" },
    { name: "never", number: 0, branch: "rehearsal/never" },
  ],
};

describe("cleanUpScenarioHandler", () => {
  const github = scratchRepoFake({ admin: true, pullsFrom: { "auto/issue-12": [40] } });

  effect("removes what was seeded and what the flow made from it", () =>
    Effect.gen(function* () {
      const cleaned = yield* cleanUpScenarioHandler({
        repo: "you/scratch",
        seeded,
        branches: ["auto/issue-12"],
        as: Option.none(),
      });

      expect(cleaned.failed).toEqual([]);
      expect(github.log).toEqual([
        "close pull request #40",
        "close pull request #7",
        "delete branch rehearsal/fix",
        "delete branch rehearsal/never",
        "delete branch auto/issue-12",
        "deleted issue #12",
      ]);
    }).pipe(Effect.provide(github.layer)),
  );

  const refusing = scratchRepoFake({ failOn: "delete branch rehearsal/fix" });

  effect("carries on past what fails, and says what that was", () =>
    Effect.gen(function* () {
      const cleaned = yield* cleanUpScenarioHandler({
        repo: "you/scratch",
        seeded,
        branches: [],
        as: Option.none(),
      });

      expect(cleaned.failed).toEqual(["branch rehearsal/fix: failed: delete branch rehearsal/fix"]);
      expect(cleaned.removed).toContain("closed issue #12");
    }).pipe(Effect.provide(refusing.layer)),
  );
});
