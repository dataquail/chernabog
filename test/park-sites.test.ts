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

  // Blocks that write a park's phase without parking, each with why: they are
  // not a second site, since the phase still says where the next run starts
  // (ADR 21, decision 4: no two park sites share a phase).
  // - plan.propose records the spec proposed with the plan as a blob, before
  //   plan.awaitAnswer's wait, which carries that plan on (#563).
  const RECORDS_WITHOUT_PARKING: ReadonlyArray<{ readonly block: string; readonly phase: string }> =
    [{ block: "plan.propose", phase: Phases.PHASES.issue.proposed }];

  // The block a site names, as "(block.name)" at the end of its description;
  // a site that names none expects its own description, which no block is.
  const siteBlock = (site: Phases.ParkSite) => /\(([\w.]+)\)$/.exec(site.site)?.[1] ?? site.site;

  test("across the documents' blocks, each park site's phase is its own block's", () => {
    const described = Schema.decodeUnknownSync(
      Schema.Struct({
        blocks: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            records: Schema.optionalKey(
              Schema.Array(Schema.Struct({ item: Schema.String, phase: Schema.String })),
            ),
            parks: Schema.optionalKey(Schema.String),
          }),
        ),
      }),
    )(Compose.describe());

    for (const site of Phases.PARKS) {
      const recording = described.blocks
        .filter((block) => (block.records ?? []).some((recorded) => recorded.phase === site.phase))
        .map((block) => block.name)
        .filter(
          (name) =>
            !RECORDS_WITHOUT_PARKING.some(
              (writer) => writer.block === name && writer.phase === site.phase,
            ),
        );

      expect([site.phase, recording]).toEqual([site.phase, [siteBlock(site)]]);
    }

    // A block that parks on a phase records it too, and parks on a park
    // site's phase; no two blocks park on the same one.
    for (const phase of parkPhases) {
      const parking = described.blocks.filter((block) => block.parks === phase);

      expect([phase, parking.length <= 1]).toEqual([phase, true]);

      for (const block of parking) {
        expect((block.records ?? []).map((recorded) => recorded.phase)).toContain(phase);
      }
    }

    for (const block of described.blocks) {
      for (const phase of Option.toArray(Option.fromUndefinedOr(block.parks))) {
        expect(parkPhases).toContain(phase);
      }
    }
  });
});
