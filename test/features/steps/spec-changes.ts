// Step definitions for a pull request that changes a spec
// (test/features/spec-changes.feature): the ones every pull request feature
// shares (pull-requests.ts), and this feature's own, over the domain layer
// only, so they run the same on every driver. pull-requests.ts says how a
// step settles and compares.
//
// "Again" here is after the latest hand-back of the pull request, or the
// author's fix when it came later: a hand-off since then, or a review.

import { expect } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { Login, World } from "../domain.ts";
import {
  acted,
  approvedAndMerged,
  known,
  pullRequestSteps,
  settled,
  type Story,
  story,
  thePullRequest,
} from "./pull-requests.ts";
import { defineSteps } from "./registry.ts";

// Where "again" starts: the latest hand-back of the pull request, or the
// fix when that came later; none for neither.
const sinceLast = (world: World, state: Story, pullRequest: number) =>
  Math.max(
    0,
    ...world.handBacks
      .filter((found) => found.pullRequest === pullRequest)
      .map((found) => found.sequence),
    ...Option.toArray(state.fix).map((found) => found.sequence),
  );

// A person isn't a persona on this machine.
const aPerson = (state: Story, login: Login) =>
  Effect.sync(() => {
    expect(state.personas).not.toContain(login);
  });

export const specChangesSteps = defineSteps(story, (keywords) => {
  const { Given, Then, When } = keywords;

  return [
    ...pullRequestSteps(keywords),

    Given(
      /^(\S+) will change the spec again when (?:she|he|they) fixes (?:her|his|their) pull request$/,
      ({ domain }, author) => domain.willChangeSpecWhenFixing(author),
    ),

    When("someone files an {word} issue whose fix changes a spec", ({ domain, state }, label) =>
      domain.fileIssue([label], "a spec").pipe(
        Effect.map((number) => {
          acted(state);
          state.issue = Option.some(number);
        }),
      ),
    ),

    When("{word}, a person, changes a spec on it", ({ domain, state }, person) =>
      Effect.gen(function* () {
        yield* aPerson(state, person);
        yield* domain.changeSpec(yield* thePullRequest(state), person);
        acted(state);
      }),
    ),

    When("{word} approves it", ({ domain, state }, login) =>
      Effect.gen(function* () {
        yield* domain.approve(yield* thePullRequest(state), login);
        acted(state);
      }),
    ),

    When("someone hands it back to the personas", ({ domain, state }) =>
      Effect.gen(function* () {
        yield* domain.handBack(yield* thePullRequest(state));
        acted(state);
      }),
    ),

    When(
      "{word}, a person, approves it and hands it back to the personas",
      ({ domain, state }, person) =>
        Effect.gen(function* () {
          const pullRequest = yield* thePullRequest(state);

          yield* aPerson(state, person);
          yield* domain.approve(pullRequest, person);
          yield* domain.handBack(pullRequest);
          acted(state);
        }),
    ),

    // Since the review that asked for changes, the author pushed nothing.
    Then("{word} does not fix it", (scenario, author) =>
      Effect.gen(function* () {
        const pullRequest = yield* thePullRequest(scenario.state);
        const changes = yield* known(scenario.state.changes, "the review asking for changes");
        const world = yield* settled(scenario);

        expect(
          world.pushes.filter(
            (push) =>
              push.pullRequest === pullRequest &&
              push.by === author &&
              push.sequence > changes.sequence,
          ),
        ).toEqual([]);
      }),
    ),

    Then("it is handed to a person again", ({ domain, state }) =>
      Effect.gen(function* () {
        const pullRequest = yield* thePullRequest(state);

        const again = yield* domain.waitUntil(
          `#${pullRequest} to be handed to a person again`,
          (world) => {
            const since = sinceLast(world, state, pullRequest);

            return Arr.findFirst(
              world.handOffs,
              (found) => found.pullRequest === pullRequest && found.sequence > since,
            ).pipe(Option.map((found) => ({ found, world })));
          },
        );

        // It was handed to a person before, too.
        expect(
          again.world.handOffs.filter(
            (found) => found.pullRequest === pullRequest && found.sequence < again.found.sequence,
          ).length,
        ).toBeGreaterThan(0);
      }),
    ),

    // Again: since the fix.
    Then("{word} does not review it again", (scenario, reviewer) =>
      Effect.gen(function* () {
        const pullRequest = yield* thePullRequest(scenario.state);
        const fix = yield* known(scenario.state.fix, "the fix");
        const world = yield* settled(scenario);

        expect(
          world.reviews.filter(
            (found) =>
              found.pullRequest === pullRequest &&
              found.reviewer === reviewer &&
              found.sequence > fix.sequence,
          ),
        ).toEqual([]);
      }),
    ),

    Then("{word} approves it and merges it", ({ domain, state }, reviewer) =>
      approvedAndMerged(domain, state, reviewer, Option.none()),
    ),
  ];
});
