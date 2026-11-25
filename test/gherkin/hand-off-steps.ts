// Step definitions for the drivers' own feature
// (test/gherkin/fixtures/hand-off.feature): one persona's work handed to
// another, over the domain layer, as a spec's steps are, so the same steps
// run on the in-process and sandbox drivers.

import { expect } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { DomainFailed, type World } from "../features/domain.ts";
import { defineSteps } from "../features/steps/registry.ts";

// The issue this scenario filed, and the pull request it is about, once seen.
type HandOff = { issue: Option.Option<number>; pullRequest: Option.Option<number> };

const theIssue = (state: HandOff) =>
  Effect.fromOption(state.issue).pipe(
    Effect.mapError(() => new DomainFailed({ message: "no issue was filed" })),
  );

const thePullRequest = (state: HandOff) =>
  Effect.fromOption(state.pullRequest).pipe(
    Effect.mapError(() => new DomainFailed({ message: "no pull request was seen yet" })),
  );

// Whether a pull request is the one this scenario is about: any, until one is.
const isThe = (state: HandOff, number: number) =>
  Option.match(state.pullRequest, { onNone: () => true, onSome: (known) => known === number });

export const handOffSteps = defineSteps(
  (): HandOff => ({ issue: Option.none(), pullRequest: Option.none() }),
  ({ Given, Then, When }) => [
    Given("{word} and {word} are personas on this machine", ({ domain }, first, second) =>
      domain.personas([first, second]),
    ),
    Given("{word} reviews for the team", ({ domain }, login) => domain.reviewForTheTeam([login])),
    Given("{word} will disagree with the changes a review asks for", ({ domain }, login) =>
      domain.willDispute(login),
    ),
    When("someone files an issue labelled {string}", ({ domain, state }, label) =>
      domain.fileIssue([label], "code").pipe(
        Effect.map((number) => {
          state.issue = Option.some(number);
        }),
      ),
    ),
    Then("{word} opens a pull request for it", ({ domain, state }, login) =>
      Effect.gen(function* () {
        const issue = yield* theIssue(state);

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
    Then("{word} asks {word} to review it", ({ domain, state }, by, reviewer) =>
      Effect.gen(function* () {
        const pullRequest = yield* thePullRequest(state);

        yield* domain.waitUntil(`${by} to ask ${reviewer} to review #${pullRequest}`, (world) =>
          Arr.findFirst(
            world.reviewRequests,
            (asked) =>
              asked.pullRequest === pullRequest && asked.by === by && asked.reviewer === reviewer,
          ),
        );
      }),
    ),
    Then(
      "{word} asks for changes on {int} line of {word} pull request",
      ({ domain, state }, reviewer, lines, owner) =>
        Effect.gen(function* () {
          const author = owner.replace(/'s$/, "");

          const authored = (world: World, number: number) =>
            world.pullRequests.some((pull) => pull.number === number && pull.author === author);

          const asked = yield* domain.waitUntil(
            `${reviewer} to ask for changes on ${author}'s pull request`,
            (world) =>
              Arr.findFirst(
                world.reviews,
                (found) =>
                  found.reviewer === reviewer &&
                  found.verdict === "changes-requested" &&
                  isThe(state, found.pullRequest) &&
                  authored(world, found.pullRequest),
              ),
          );

          state.pullRequest = Option.some(asked.pullRequest);
          expect(asked.lineComments).toBe(lines);
        }),
    ),
    Then("{word} answers the review in the session she wrote it in", ({ domain, state }, author) =>
      Effect.gen(function* () {
        const pullRequest = yield* thePullRequest(state);

        yield* domain.waitUntil(`${author} to answer the review of #${pullRequest}`, (world) =>
          Arr.findFirst(
            world.replies,
            (reply) => reply.pullRequest === pullRequest && reply.author === author,
          ),
        );

        const sessions = (yield* domain.world).sessions.filter(
          (found) => found.pullRequest === pullRequest && found.persona === author,
        );

        // Writing it, then weighing the review: two stretches, one conversation.
        expect(sessions.length).toBeGreaterThan(1);
        expect(new Set(sessions.map((found) => found.session)).size).toBe(1);
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
    When("the machine has nothing left to do", ({ domain }) => domain.settle),
    Then("{word} pushed once", ({ domain, state }, login) =>
      Effect.gen(function* () {
        const pullRequest = yield* thePullRequest(state);
        const world = yield* domain.world;

        expect(
          world.pushes.filter((push) => push.pullRequest === pullRequest && push.by === login),
        ).toHaveLength(1);
      }),
    ),
    Then("nobody merged it", ({ domain, state }) =>
      Effect.gen(function* () {
        const pullRequest = yield* thePullRequest(state);
        const world = yield* domain.world;

        expect(
          world.pullRequests
            .filter((pull) => pull.number === pullRequest)
            .map((pull) => Option.isNone(pull.mergedBy)),
        ).toEqual([true]);
      }),
    ),
  ],
);
