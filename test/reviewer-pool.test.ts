// The reviewer pool, as the flows that use it tell chernabog of it (#208):
// the SDK's review blocks give doctor its checks, the recipes that ask for or
// give reviews include them under whatever name a repo gives them, and the
// review recipe's trigger reports the requests no persona here serves as
// waiting on them, for status. The binary names no recipe.

import { defineFlow, type Flow, Machine, Review, RunLog, triggerOf } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import epic from "../packages/recipes/flows/epic.ts";
import humanInitiated from "../packages/recipes/flows/human-initiated.ts";
import implement from "../packages/recipes/flows/implement.ts";
import reReview from "../packages/recipes/flows/re-review.ts";
import review from "../packages/recipes/flows/review.ts";
import { flowWarnings } from "../src/modules/runs/infrastructure/runtime/diagnostics.ts";
import { type EffectiveRepo } from "../src/repo-config.ts";
import { effect } from "./effect-test.ts";
import { asPersona, makeFake, onFake, PULL, repoAs, settings } from "./sdk-fakes.ts";

// The repo as these personas run it here, each running the flows listed for
// it; the pool is alice and bob.
const repoWith = (
  ...flows: Arr.NonEmptyReadonlyArray<readonly [string, ReadonlyArray<string>]>
): EffectiveRepo => {
  const pooled = { ...settings, reviewers: ["alice", "bob"] };

  return {
    ...repoAs(pooled),
    personas: Arr.map(flows, ([login, chosen]) => ({
      ...asPersona(pooled, Option.some(login)),
      chosen,
    })),
  };
};

const warningsOf = (
  repo: EffectiveRepo,
  flows: ReadonlyMap<string, Flow>,
  personas: ReadonlyArray<string>,
) =>
  Effect.map(
    flowWarnings(repo, flows, personas, (persona) => Effect.succeed(persona)),
    (found) => found.map(({ persona, warning }) => [Option.getOrNull(persona), warning.warning]),
  );

describe("doctor's reviewer-pool checks, as the recipes contribute them", () => {
  // This repo's names for the recipes: a repo that renames review keeps its checks.
  const recipes = new Map<string, Flow>([
    ["build", implement],
    ["pair", humanInitiated],
    ["epics", epic],
    ["pr-review", review],
    ["pr-re-review", reReview],
  ]);

  effect("warns when the pull requests a persona opens go only to logins this machine isn't", () =>
    Effect.gen(function* () {
      const said = yield* warningsOf(repoWith(["alice", ["build"]]), recipes, ["alice"]);

      expect(said).toEqual([
        [
          "alice",
          "pull requests authored as alice go to bob, which this machine doesn't act as; they wait until another machine reviews them",
        ],
      ]);
    }),
  );

  effect("warns when no reviewer it may ask runs a flow that reviews here, whatever its name", () =>
    Effect.gen(function* () {
      const said = yield* warningsOf(
        repoWith(["alice", ["build", "pr-review", "pr-re-review"]]),
        recipes,
        ["alice", "bob"],
      );

      expect(said).toEqual([
        [
          "alice",
          "pull requests authored as alice go to bob, which no persona here reviews as: none of them runs a flow that reviews (pr-review, pr-re-review) here",
        ],
      ]);
    }),
  );

  effect("warns when a persona reviews here without a seat in the pool", () =>
    Effect.gen(function* () {
      const said = yield* warningsOf(repoWith(["carol", ["pr-review"]]), recipes, ["carol"]);

      expect(said).toEqual([
        [
          "carol",
          "carol runs pr-review, but the reviewer pool (alice, bob) doesn't list it, so no pull request asks it to review",
        ],
      ]);
    }),
  );

  effect("stays quiet when a reviewer here runs them", () =>
    Effect.gen(function* () {
      const said = yield* warningsOf(
        repoWith(["alice", ["build"]], ["bob", ["pr-review", "pr-re-review"]]),
        recipes,
        ["alice", "bob"],
      );

      expect(said).toEqual([]);
    }),
  );

  effect("gives nothing for flows that contribute no checks, whatever their names", () =>
    Effect.gen(function* () {
      const quiet = defineFlow({ trigger: Effect.succeed([]), workflow: () => Effect.void });

      const said = yield* warningsOf(
        repoWith(["alice", ["implement", "review"]]),
        new Map([
          ["implement", quiet],
          ["review", quiet],
        ]),
        ["alice"],
      );

      expect(said).toEqual([]);
    }),
  );
});

describe("review requests no persona here serves", () => {
  const asksBob = () => {
    const fake = makeFake("approve");
    fake.people.requested.push("bob");

    return fake;
  };

  const here = (personas: ReadonlyArray<string>) =>
    Effect.provideService(Machine, Machine.of({ personas }));

  const quiet = Effect.provideService(
    RunLog,
    RunLog.of({ log: () => Effect.void, step: () => Effect.void, stepDone: () => Effect.void }),
  );

  effect("wait on the logins this machine isn't, as the review recipe's trigger reports", () =>
    Effect.gen(function* () {
      const found = yield* onFake(
        asksBob(),
        triggerOf(review).pipe(here(["chernabog-bot"]), quiet),
      );

      expect(found.map((item) => [item.key, item.waitsOn])).toEqual([
        [`pr-${PULL}`, { who: "bob", why: "not on this machine" }],
      ]);
    }),
  );

  effect("are none when this machine acts as the reviewer, or doesn't say who it is", () =>
    Effect.gen(function* () {
      expect(
        yield* onFake(asksBob(), Review.waitingElsewhere.pipe(here(["chernabog-bot", "Bob"]))),
      ).toEqual([]);
      expect(yield* onFake(asksBob(), Review.waitingElsewhere)).toEqual([]);
    }),
  );

  effect("leave a pull request that asks this persona too to the trigger's own work", () =>
    Effect.gen(function* () {
      const fake = asksBob();
      fake.people.requested.push("chernabog-bot");

      expect(yield* onFake(fake, Review.waitingElsewhere.pipe(here(["chernabog-bot"])))).toEqual(
        [],
      );
    }),
  );
});

describe("chernabog start's entry point", () => {
  effect("is the hybrid recipe, by what it declares", () =>
    Effect.sync(() => {
      expect([humanInitiated, implement, review].map((flow) => flow.start === true)).toEqual([
        true,
        false,
        false,
      ]);
    }),
  );
});
