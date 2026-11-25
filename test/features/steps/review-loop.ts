// Step definitions for the review loop (test/features/review-loop.feature),
// over the domain layer only, so they run the same on every driver.
//
// A step that says something never happened, or is left as it is, first
// lets the machine settle: what it would do next, it has done by then. A
// step that says "again", "the fix", "the same session" or "pushes nothing"
// compares by the world's one order of events (domain.ts' Sequenced): with
// the review that asked for changes, or the fix, as an earlier step saw them,
// and never with a world seen at an earlier step.

import { expect } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { DomainFailed, type Login, type PushSeen, type ReviewSeen, type World } from "../domain.ts";
import { defineSteps, type Scenario } from "./registry.ts";

type ReviewLoop = {
  personas: ReadonlyArray<Login>;
  issue: Option.Option<number>;
  pullRequest: Option.Option<number>;
  // The review that asked for changes: what the loop did before it, and after.
  changes: Option.Option<ReviewSeen>;
  // The author's fix: the push after that review.
  fix: Option.Option<PushSeen>;
  // Whether the machine has settled since a step last acted on it.
  settled: boolean;
};

type Step = Scenario<ReviewLoop>;

const failed = (message: string) => new DomainFailed({ message });

const known = <A>(found: Option.Option<A>, what: string) =>
  Effect.fromOption(found).pipe(Effect.mapError(() => failed(`${what} wasn't seen yet`)));

const thePullRequest = (state: ReviewLoop) => known(state.pullRequest, "a pull request");

// Lets the machine settle, once for each time a step acts on it.
const settled = ({ domain, state }: Step) =>
  Effect.gen(function* () {
    if (!state.settled) {
      yield* domain.settle;
      state.settled = true;
    }

    return yield* domain.world;
  });

// A step acted on the machine: whatever it was settled on has changed.
const acted = (state: ReviewLoop) => {
  state.settled = false;
};

const pullIn = (world: World, number: number) =>
  Effect.fromOption(Arr.findFirst(world.pullRequests, (pull) => pull.number === number)).pipe(
    Effect.mapError(() => failed(`pull request #${number} can't be seen`)),
  );

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

// The author's fix: their push after the review that asked for it, which
// moves the pull request off the commit the review was of. Answers that
// review, for a step that also checks the session.
const fixed = (domain: Step["domain"], state: ReviewLoop, author: Login) =>
  Effect.gen(function* () {
    const pullRequest = yield* thePullRequest(state);
    const changes = yield* known(state.changes, "the review asking for changes");

    const fix = yield* domain.waitUntil(`${author} to push a fix to #${pullRequest}`, (world) =>
      Arr.findFirst(
        world.pushes,
        (push) =>
          push.pullRequest === pullRequest &&
          push.by === author &&
          push.sequence > changes.sequence,
      ),
    );

    state.fix = Option.some(fix);
    expect(fix.head).not.toBe(changes.head);

    return changes;
  });

// The reviewer's review of the fix, after it. Answers the review that asked
// for changes, for a step that also checks the session.
const reReviewed = (domain: Step["domain"], state: ReviewLoop, reviewer: Login) =>
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

export const reviewLoopSteps = defineSteps(
  (): ReviewLoop => ({
    personas: [],
    issue: Option.none(),
    pullRequest: Option.none(),
    changes: Option.none(),
    fix: Option.none(),
    settled: false,
  }),
  ({ Given, Then, When }) => [
    Given("{word} and {word} are personas on this machine", ({ domain, state }, first, second) =>
      domain.personas([first, second]).pipe(
        Effect.map(() => {
          state.personas = [...state.personas, first, second];
        }),
      ),
    ),

    Given("{word} and {word} both review for the team", ({ domain }, first, second) =>
      domain.reviewForTheTeam([first, second]),
    ),

    // The domain's dispute is the author's, of whatever a review asks: in
    // this feature only the named reviewer reviews the author's work.
    Given("{word} will disagree with the changes {word} asks for", ({ domain }, author) =>
      domain.willDispute(author),
    ),

    When("someone files an {word} issue", ({ domain, state }, label) =>
      domain.fileIssue([label]).pipe(
        Effect.map((number) => {
          acted(state);
          state.issue = Option.some(number);
        }),
      ),
    ),

    Then("{word} opens a pull request for it", ({ domain, state }, login) =>
      Effect.gen(function* () {
        const issue = yield* known(state.issue, "an issue");

        const opened = yield* domain.waitUntil(
          `${login} to open a pull request for #${issue}`,
          (world) =>
            Arr.findFirst(
              world.pullRequests,
              (pull) => pull.author === login && Option.contains(pull.issue, issue),
            ),
        );

        state.pullRequest = Option.some(opened.number);
      }),
    ),

    Then("{word} asks for changes on one line", ({ domain, state }, reviewer) =>
      Effect.gen(function* () {
        const pullRequest = yield* thePullRequest(state);

        const asked = yield* domain.waitUntil(
          `${reviewer} to ask for changes on #${pullRequest}`,
          (world) =>
            Arr.findFirst(
              world.reviews,
              (found) =>
                found.pullRequest === pullRequest &&
                found.reviewer === reviewer &&
                found.verdict === "changes-requested",
            ),
        );

        state.changes = Option.some(asked);
        expect(asked.lineComments).toBe(1);
      }),
    ),

    Then("{word} fixes it", ({ domain, state }, author) =>
      fixed(domain, state, author).pipe(Effect.asVoid),
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
        const pullRequest = yield* thePullRequest(state);
        const fix = yield* known(state.fix, "the fix");

        const merged = yield* domain.waitUntil(`#${pullRequest} to be merged`, (world) =>
          Arr.findFirst(world.merges, (merge) => merge.pullRequest === pullRequest).pipe(
            Option.map((merge) => ({ merge, world })),
          ),
        );

        const { merge, world } = merged;

        expect(merge.by).toBe(reviewer);
        expect((yield* pullIn(world, pullRequest)).mergedBy).toEqual(Option.some(reviewer));
        expect((yield* pullIn(world, pullRequest)).head).toBe(fix.head);
        // The last review the reviewer gave before merging approved the fix.
        expect(
          world.reviews
            .filter(
              (found) =>
                found.pullRequest === pullRequest &&
                found.reviewer === reviewer &&
                found.sequence < merge.sequence,
            )
            .map((found) => ({ verdict: found.verdict, head: found.head }))
            .at(-1),
        ).toEqual({ verdict: "approved", head: fix.head });
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

    Then("it is handed to a person", ({ domain, state }) =>
      Effect.gen(function* () {
        const pullRequest = yield* thePullRequest(state);

        yield* domain.waitUntil(`#${pullRequest} to be handed to a person`, (world) =>
          Arr.findFirst(world.handOffs, (handOff) => handOff.pullRequest === pullRequest),
        );
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

    Then("it is left for a person to merge", (scenario) =>
      Effect.gen(function* () {
        const pullRequest = yield* thePullRequest(scenario.state);
        const world = yield* settled(scenario);

        expect((yield* pullIn(world, pullRequest)).mergedBy).toEqual(Option.none());
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

    Then("nobody on this machine reviews it", (scenario) =>
      Effect.gen(function* () {
        const pullRequest = yield* thePullRequest(scenario.state);
        const world = yield* settled(scenario);

        expect(
          world.reviews.filter(
            (found) =>
              found.pullRequest === pullRequest && scenario.state.personas.includes(found.reviewer),
          ),
        ).toEqual([]);
      }),
    ),

    When("{word} is asked to review it", ({ domain, state }, reviewer) =>
      Effect.gen(function* () {
        const pullRequest = yield* thePullRequest(state);

        yield* domain.askToReview(pullRequest, [reviewer]);
        acted(state);
      }),
    ),

    Then("{word} reviews it", ({ domain, state }, reviewer) =>
      Effect.gen(function* () {
        const pullRequest = yield* thePullRequest(state);

        yield* domain.waitUntil(`${reviewer} to review #${pullRequest}`, (world) =>
          Arr.findFirst(
            world.reviews,
            (found) => found.pullRequest === pullRequest && found.reviewer === reviewer,
          ),
        );
      }),
    ),

    Then("{word} is still asked to review it", (scenario, reviewer) =>
      Effect.gen(function* () {
        const pullRequest = yield* thePullRequest(scenario.state);
        const world = yield* settled(scenario);

        expect((yield* pullIn(world, pullRequest)).requested).toContain(reviewer);
      }),
    ),
  ],
);
