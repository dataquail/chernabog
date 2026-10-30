import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { ScenarioRoot } from "../domain/scenario/scenario.root.ts";
import { scratchRepoFake } from "../infrastructure/clients/scratch-repo.client-fake.ts";
import { seedScenarioHandler } from "./seed-scenario.handler.ts";

const scenario = ScenarioRoot.make({
  path: "/r/s.yaml",
  dir: "/r",
  repo: "you/scratch",
  given: {
    issues: [{ name: "bug", title: "The button does nothing", labels: ["auto:eligible"] }],
    pullRequests: [
      { name: "fix", branch: "rehearsal/fix", title: "Fix", commits: [] },
      { name: "docs", branch: "rehearsal/docs", title: "Docs", base: "next", commits: [] },
    ],
  },
});

describe("seedScenarioHandler", () => {
  const seeded = scratchRepoFake();

  effect(
    "seeds the issues, then the pull requests, on the default branch unless one names its own",
    () =>
      Effect.gen(function* () {
        const made = yield* seedScenarioHandler({ scenario, as: Option.some("alice") });

        expect(made).toEqual({
          issues: [{ name: "bug", number: 100 }],
          pullRequests: [
            { name: "fix", number: 101, branch: "rehearsal/fix" },
            { name: "docs", number: 102, branch: "rehearsal/docs" },
          ],
        });
        expect(seeded.log).toEqual([
          "open issue The button does nothing",
          "open pull request rehearsal/fix on main",
          "open pull request rehearsal/docs on next",
        ]);
      }).pipe(Effect.provide(seeded.layer)),
  );

  const failing = scratchRepoFake({ failOn: "open pull request rehearsal/docs" });

  effect("a seeding that fails partway says what it made, for cleanup", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(seedScenarioHandler({ scenario, as: Option.none() }));

      expect(failure.seeded).toEqual({
        issues: [{ name: "bug", number: 100 }],
        pullRequests: [
          { name: "fix", number: 101, branch: "rehearsal/fix" },
          { name: "docs", number: 0, branch: "rehearsal/docs" },
        ],
      });
    }).pipe(Effect.provide(failing.layer)),
  );
});
