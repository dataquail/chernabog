import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { ScenarioRoot } from "../domain/scenario/scenario.root.ts";
import { scratchRepoFake } from "../infrastructure/clients/scratch-repo.client-fake.ts";
import { checkRehearsalHandler } from "./check-rehearsal.handler.ts";

const scenario = ScenarioRoot.make({
  path: "/r/s.yaml",
  dir: "/r",
  repo: "you/scratch",
  expect: { ends: "done", labels: ["auto:needs-review"] },
});

describe("checkRehearsalHandler", () => {
  const github = scratchRepoFake({
    states: {
      12: { labels: [], reviewRequests: [] },
      40: { labels: ["auto:needs-review"], reviewRequests: ["bob"] },
    },
    pullsFrom: { "auto/issue-12": [40] },
  });

  effect("reads back the item's labels and the review requests the run left", () =>
    Effect.gen(function* () {
      const check = yield* checkRehearsalHandler({
        scenario,
        seeded: { issues: [{ name: "bug", number: 12 }], pullRequests: [] },
        item: "issue-12",
        ending: "done",
        summary: "#12: pull request ready for review",
        branches: ["auto/issue-12"],
        standIns: { implement: { fixture: {} }, "old-step": { fixture: {} } },
        asked: ["implement"],
        as: Option.none(),
      });

      expect(check.labels).toEqual([]);
      expect(check.missed).toEqual(["the item carries no labels, not auto:needs-review"]);
      expect(check.reviewRequests).toEqual([{ pullRequest: 40, logins: ["bob"] }]);
      expect(check.unused).toEqual(["old-step"]);
    }).pipe(Effect.provide(github.layer)),
  );
});
