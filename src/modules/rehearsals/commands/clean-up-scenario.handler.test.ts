import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
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

const nothingRun = { createdIssues: [], claims: [] };

describe("cleanUpScenarioHandler", () => {
  const github = scratchRepoFake({ admin: true, pullsFrom: { "auto/issue-12": [40] } });

  effect("removes what was seeded and what the flow made from it", () =>
    Effect.gen(function* () {
      const cleaned = yield* cleanUpScenarioHandler({
        repo: "you/scratch",
        seeded,
        branches: ["auto/issue-12"],
        run: nothingRun,
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
    }).pipe(Effect.provide([github.layer, PassThroughUnitOfWork])),
  );

  const planned = scratchRepoFake({ admin: true });

  effect("removes the issues the run created, such as a plan's sub-issues", () =>
    Effect.gen(function* () {
      const cleaned = yield* cleanUpScenarioHandler({
        repo: "you/scratch",
        seeded: { issues: [{ name: "spec", number: 12 }], pullRequests: [] },
        branches: [],
        run: { createdIssues: [13, 14, 12], claims: [] },
        as: Option.none(),
      });

      expect(cleaned.failed).toEqual([]);
      expect(planned.log).toEqual(["deleted issue #12", "deleted issue #13", "deleted issue #14"]);
      expect(cleaned.removed).toContain("deleted issue #13 (the run created it)");
    }).pipe(Effect.provide([planned.layer, PassThroughUnitOfWork])),
  );

  const parked = scratchRepoFake({ admin: true, claimRefs: { "epic-12": "run-1" } });

  effect("deletes the claim refs the run took, such as a parked epic's", () =>
    Effect.gen(function* () {
      const cleaned = yield* cleanUpScenarioHandler({
        repo: "you/scratch",
        seeded: { issues: [{ name: "epic", number: 12 }], pullRequests: [] },
        branches: [],
        run: { createdIssues: [], claims: [{ item: "epic-12", runId: "run-1" }] },
        as: Option.none(),
      });

      expect(cleaned.failed).toEqual([]);
      expect(parked.log).toEqual([
        "delete claim ref refs/chernabog/claims/epic-12",
        "deleted issue #12",
      ]);
      expect(cleaned.removed).toContain("deleted claim ref refs/chernabog/claims/epic-12");
    }).pipe(Effect.provide([parked.layer, PassThroughUnitOfWork])),
  );

  // Real work on the repo: an issue the run didn't create, and a claim ref
  // another run took over from it, on an item it once claimed.
  const enrolled = scratchRepoFake({
    admin: true,
    claimRefs: { "issue-5": "real-run", "issue-6": "real-run" },
  });

  effect("removes nothing the run didn't make", () =>
    Effect.gen(function* () {
      const cleaned = yield* cleanUpScenarioHandler({
        repo: "you/scratch",
        seeded: { issues: [], pullRequests: [] },
        branches: [],
        run: { createdIssues: [], claims: [{ item: "issue-5", runId: "run-1" }] },
        as: Option.none(),
      });

      expect(cleaned.failed).toEqual([]);
      expect(cleaned.removed).toEqual([]);
      expect(enrolled.log).toEqual([]);
    }).pipe(Effect.provide([enrolled.layer, PassThroughUnitOfWork])),
  );

  const refusing = scratchRepoFake({ failOn: "delete branch rehearsal/fix" });

  effect("carries on past what fails, and says what that was", () =>
    Effect.gen(function* () {
      const cleaned = yield* cleanUpScenarioHandler({
        repo: "you/scratch",
        seeded,
        branches: [],
        run: nothingRun,
        as: Option.none(),
      });

      expect(cleaned.failed).toEqual(["branch rehearsal/fix: failed: delete branch rehearsal/fix"]);
      expect(cleaned.removed).toContain("closed issue #12");
    }).pipe(Effect.provide([refusing.layer, PassThroughUnitOfWork])),
  );
});
