// The step definitions every pull request feature shares (review-loop.feature,
// spec-changes.feature), over the domain layer only, so they run the same on
// every driver; and the state and helpers each feature's own steps build on.
// A feature's steps are these and its own (review-loop.ts, spec-changes.ts).
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

import {
  type Domain,
  DomainFailed,
  type Login,
  type PushSeen,
  type ReviewSeen,
  type World,
} from "../domain.ts";
import type { Keywords, Scenario, StepDefinition } from "./registry.ts";

export type Story = {
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

export const story = (): Story => ({
  personas: [],
  issue: Option.none(),
  pullRequest: Option.none(),
  changes: Option.none(),
  fix: Option.none(),
  settled: false,
});

export type Step = Scenario<Story>;

export const failed = (message: string) => new DomainFailed({ message });

export const known = <A>(found: Option.Option<A>, what: string) =>
  Effect.fromOption(found).pipe(Effect.mapError(() => failed(`${what} wasn't seen yet`)));

export const thePullRequest = (state: Story) => known(state.pullRequest, "a pull request");

// Lets the machine settle, once for each time a step acts on it.
export const settled = ({ domain, state }: Step) =>
  Effect.gen(function* () {
    if (!state.settled) {
      yield* domain.settle;
      state.settled = true;
    }

    return yield* domain.world;
  });

// A step acted on the machine: whatever it was settled on has changed.
export const acted = (state: Story) => {
  state.settled = false;
};

export const pullIn = (world: World, number: number) =>
  Effect.fromOption(Arr.findFirst(world.pullRequests, (pull) => pull.number === number)).pipe(
    Effect.mapError(() => failed(`pull request #${number} can't be seen`)),
  );

// The author's fix: their push after the review that asked for it, which
// moves the pull request off the commit the review was of. Answers that
// review, for a step that also checks the session.
export const fixed = (domain: Domain, state: Story, author: Login) =>
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

// The reviewer merged the pull request, and the last review they gave before
// merging approved the head it merged at, `head` when a step knows it.
export const approvedAndMerged = (
  domain: Domain,
  state: Story,
  reviewer: Login,
  head: Option.Option<string>,
) =>
  Effect.gen(function* () {
    const pullRequest = yield* thePullRequest(state);

    const { merge, world } = yield* domain.waitUntil(`#${pullRequest} to be merged`, (now) =>
      Arr.findFirst(now.merges, (found) => found.pullRequest === pullRequest).pipe(
        Option.map((found) => ({ merge: found, world: now })),
      ),
    );

    const pull = yield* pullIn(world, pullRequest);

    expect(merge.by).toBe(reviewer);
    expect(pull.mergedBy).toEqual(Option.some(reviewer));
    expect(pull.head).toBe(Option.getOrElse(head, () => pull.head));
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
    ).toEqual({ verdict: "approved", head: pull.head });
  });

// The steps both features use.
export const pullRequestSteps = ({
  Given,
  Then,
  When,
}: Keywords<Story>): ReadonlyArray<StepDefinition<Story>> => [
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

  When("someone files an {word} issue", ({ domain, state }, label) =>
    domain.fileIssue([label], "code").pipe(
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

  Then("it is handed to a person", ({ domain, state }) =>
    Effect.gen(function* () {
      const pullRequest = yield* thePullRequest(state);

      yield* domain.waitUntil(`#${pullRequest} to be handed to a person`, (world) =>
        Arr.findFirst(world.handOffs, (handOff) => handOff.pullRequest === pullRequest),
      );
    }),
  ),

  Then("it is left for a person to merge", (scenario) =>
    Effect.gen(function* () {
      const pullRequest = yield* thePullRequest(scenario.state);
      const world = yield* settled(scenario);

      expect((yield* pullIn(world, pullRequest)).mergedBy).toEqual(Option.none());
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
];
