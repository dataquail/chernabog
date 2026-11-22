// Every park site records a phase of its own (ADR 21, decision 4, as #557
// amended it): a park is a phase boundary, so the phase alone says where the
// run that takes the item up starts. The catalogue of park sites
// (Phases.PARKS) names each, and these tests hold the recipes' waits and the
// documents' blocks to it: no two sites, across recipes and documents, share
// a phase.

import { Compose, Implement, Phases, Plan, Review } from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const ISSUE = 3;
const PULL = 7;

const parkPhases: ReadonlyArray<string> = Phases.PARKS.map((site) => site.phase);

// The phase a wait for CI's constructor parks on, in `round`.
const ciPhase = (wait: Implement.CiWait, round: number) =>
  Option.getOrThrow(Option.fromUndefinedOr(wait.park))(round).phase;

describe("the park sites' catalogue", () => {
  test("no two park sites record the same phase", () => {
    expect(new Set(parkPhases).size).toBe(parkPhases.length);
  });

  test("no site's later round is another site's phase", () => {
    for (const site of Phases.PARKS) {
      for (const other of Phases.PARKS) {
        if (site !== other) {
          expect(Phases.declaredAs(`${site.phase}-2`)).not.toBe(other.phase);
        }
      }
    }
  });

  test("each park site's phase is one of its item's kind", () => {
    for (const site of Phases.PARKS) {
      expect(Phases.misplacedOn(site.item, site.phase)).toEqual(Option.none());
    }
  });

  test("implement's two waits for CI park on phases of their own", () => {
    expect(ciPhase(Implement.parkOnIssue(ISSUE), 1)).toBe(Phases.PHASES.issue.awaitingCi);
    expect(ciPhase(Implement.parkOnAdopted(ISSUE, PULL), 1)).toBe(
      Phases.PHASES.issue.awaitingAdoptedCi,
    );
    expect(ciPhase(Implement.parkOnAdopted(ISSUE, PULL), 2)).toBe("awaiting-adopted-ci-2");
  });

  test("each recipe's wait records its own site's phase", () => {
    const recipes = [
      ciPhase(Implement.parkOnIssue(ISSUE), 1),
      ciPhase(Implement.parkOnAdopted(ISSUE, PULL), 1),
      ciPhase(Review.parkOnPullRequest(PULL), 1),
      Plan.answerParking(ISSUE, 1, "1 day").phase,
    ];

    expect(new Set(recipes).size).toBe(recipes.length);

    for (const phase of recipes) {
      expect(parkPhases).toContain(Phases.declaredAs(phase));
    }
  });

  test("address-review's wait on its fix's CI is not implement's", () => {
    expect(ciPhase(Review.parkOnPullRequest(PULL), 1)).toBe(
      Phases.PHASES.pullRequest.awaitingFixCi,
    );
    expect(ciPhase(Review.parkOnPullRequest(PULL), 3)).toBe("awaiting-fix-ci-3");
  });

  test("across the documents' blocks, each park site's phase is one block's", () => {
    const described = Schema.decodeUnknownSync(
      Schema.Struct({
        blocks: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            records: Schema.optionalKey(
              Schema.Array(Schema.Struct({ item: Schema.String, phase: Schema.String })),
            ),
          }),
        ),
      }),
    )(Compose.describe());

    // The block each site names, as "(plan.awaitAnswer)" ends its site.
    const parkBlock = (site: string) => site.match(/\(([^)]+)\)$/)?.[1] ?? site;
    const parkBlocks = new Set(Phases.PARKS.map((site) => parkBlock(site.site)));

    for (const site of Phases.PARKS) {
      // A block that parks nowhere may record a park's phase too, as
      // plan.propose records the spec's proposed with the posted plan; no
      // other park site's block may.
      const parking = described.blocks
        .filter(
          (block) =>
            parkBlocks.has(block.name) &&
            (block.records ?? []).some((recorded) => recorded.phase === site.phase),
        )
        .map((block) => block.name);

      expect([site.phase, parking]).toEqual([site.phase, [parkBlock(site.site)]]);
    }
  });
});
