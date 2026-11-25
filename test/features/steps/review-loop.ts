// Step definitions for the review loop (test/features/review-loop.feature):
// the ones every pull request feature shares (pull-requests.ts), and the
// loop's own, over the domain layer only, so they run the same on every
// driver. pull-requests.ts says how a step settles and compares.

import { expect } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { DomainFailed, Login, ReviewSeen, World } from "../domain.ts";
import {
  acted,
  approvedAndMerged,
  fixed,
  known,
  pullIn,
  pullRequestSteps,
  settled,
  type Step,
  type Story,
  story,
  thePullRequest,
} from "./pull-requests.ts";
import { defineSteps } from "./registry.ts";

const sessionsOf = (world: World, pullRequest: number, persona: Login) =>
  world.sessions.filter((found) => found.pullRequest === pullRequest && found.persona === persona);

// The persona's sessions on the pull request: those before `review`, and
// those after it, which must carry on the same one session.
const carriedOn = (
  world: World,
  review: ReviewSeen,
  persona: Login,
  what: string,
): Effect.Effect<void, DomainFailed> => {
  const { pullRequest } = review;
  const all = sessionsOf(world, pullRequest, persona);
  const before = all.filter((found) => found.sequence < review.sequence);
  const after = all.filter((found) => found.sequence > review.sequence);

  return Effect.sync(() => {
    expect(before.length, `${persona}'s sessions on #${pullRequest} ${what}`).toBeGreaterThan(0);
    expect(after.length, `${persona}'s sessions on #${pullRequest} since`).toBeGreaterThan(0);
    // One conversation, carried on: the same session, resumed, not a new one.
    expect(new Set(all.map((found) => found.session)).size).toBe(1);
    expect(after.map((found) => found.resumed)).toEqual(after.map(() => true));
  });
};

// The reviewer's review of the fix, after it. Answers the review that asked
// for changes, for a step that also checks the session.
const reReviewed = (domain: Step["domain"], state: Story, reviewer: Login) =>
  Effect.gen(function* () {
    const pullRequest = yield* thePullRequest(state);
    const changes = yield* known(state.changes, "the review asking for changes");
    const fix = yield* known(state.fix, "the fix");

    yield* domain.waitUntil(`${reviewer} to review the fix on #${pullRequest}`, (world) =>
      Arr.findFirst(
        world.reviews,
        (found) =>
          found.pullRequest === pullRequest &&
          found.reviewer === reviewer &&
          found.head === fix.head &&
          found.sequence > fix.sequence,
      ),
    );

    return changes;
  });

export const reviewLoopSteps = defineSteps(story, (keywords) => {
  const { Given, Then, When } = keywords;

  return [
    ...pullRequestSteps(keywords),

    // The domain's dispute is the author's, of whatever a review asks: in
    // this feature only the named reviewer reviews the author's work.
    Given("{word} will disagree with the changes {word} asks for", ({ domain }, author) =>
      domain.willDispute(author),
    ),

    Then(
      /^(\S+) fixes it in the same session (?:she|he|they) wrote it in$/,
      ({ domain, state }, author) =>
        Effect.gen(function* () {
          const changes = yield* fixed(domain, state, author);

          yield* carriedOn(yield* domain.world, changes, author, "before the review");
        }),
    ),

    Then("{word} re-reviews the fix", ({ domain, state }, reviewer) =>
      reReviewed(domain, state, reviewer).pipe(Effect.asVoid),
    ),

    Then(
      /^(\S+) re-reviews the fix in the same session (?:she|he|they) reviewed it in$/,
      ({ domain, state }, reviewer) =>
        Effect.gen(function* () {
          const changes = yield* reReviewed(domain, state, reviewer);

          yield* carriedOn(yield* domain.world, changes, reviewer, "before the review");
        }),
    ),

    Then("{word} approves the fixed pull request and merges it", ({ domain, state }, reviewer) =>
      Effect.gen(function* () {
        const fix = yield* known(state.fix, "the fix");

        yield* approvedAndMerged(domain, state, reviewer, Option.some(fix.head));
      }),
    ),

    Then(/^(\S+) never reviews (?:her|his|their) own pull request$/, (scenario, author) =>
      Effect.gen(function* () {
        const pullRequest = yield* thePullRequest(scenario.state);
        const world = yield* settled(scenario);

        expect((yield* pullIn(world, pullRequest)).author).toBe(author);
        expect(
          world.reviews.filter(
            (found) => found.pullRequest === pullRequest && found.reviewer === author,
          ),
        ).toEqual([]);
      }),
    ),

    Then("it is never handed to a person", (scenario) =>
      Effect.gen(function* () {
        const pullRequest = yield* thePullRequest(scenario.state);
        const world = yield* settled(scenario);

        expect(world.handOffs.filter((found) => found.pullRequest === pullRequest)).toEqual([]);
      }),
    ),

    Then(
      /^(\S+) answers the review with (?:her|his|their) reasons and pushes nothing$/,
      (scenario, author) =>
        Effect.gen(function* () {
          const { domain, state } = scenario;
          const pullRequest = yield* thePullRequest(state);
          const changes = yield* known(state.changes, "the review asking for changes");

          yield* domain.waitUntil(`${author} to answer the review with reasons`, (world) =>
            Arr.findFirst(
              world.replies,
              (reply) =>
                reply.pullRequest === pullRequest &&
                reply.author === author &&
                Option.isSome(reply.reasons),
            ),
          );

          const world = yield* settled(scenario);

          // Nothing since the review, and it is still the commit the review was of.
          expect(
            world.pushes.filter(
              (push) => push.pullRequest === pullRequest && push.sequence > changes.sequence,
            ),
          ).toEqual([]);
          expect((yield* pullIn(world, pullRequest)).head).toBe(changes.head);
        }),
    ),

    // Again: after the review that asked for changes.
    Then("nobody is asked to review it again", (scenario) =>
      Effect.gen(function* () {
        const pullRequest = yield* thePullRequest(scenario.state);
        const changes = yield* known(scenario.state.changes, "the review asking for changes");
        const world = yield* settled(scenario);

        expect(
          world.reviewRequests.filter(
            (found) => found.pullRequest === pullRequest && found.sequence > changes.sequence,
          ),
        ).toEqual([]);
      }),
    ),

    When("{word}, a person, opens a pull request", ({ domain, state }, author) =>
      Effect.gen(function* () {
        expect(state.personas).not.toContain(author);

        const number = yield* domain.openPullRequest(author);

        acted(state);
        state.pullRequest = Option.some(number);
      }),
    ),

    When(
      "only {word}, who is not on this machine, is asked to review it",
      ({ domain, state }, reviewer) =>
        Effect.gen(function* () {
          expect(state.personas).not.toContain(reviewer);

          const pullRequest = yield* thePullRequest(state);

          yield* domain.askToReview(pullRequest, [reviewer]);
          acted(state);
          expect((yield* pullIn(yield* domain.world, pullRequest)).requested).toEqual([reviewer]);
        }),
    ),

    Then("{word} is still asked to review it", (scenario, reviewer) =>
      Effect.gen(function* () {
        const pullRequest = yield* thePullRequest(scenario.state);
        const world = yield* settled(scenario);

        expect((yield* pullIn(world, pullRequest)).requested).toContain(reviewer);
      }),
    ),
  ];
});
