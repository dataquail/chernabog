// Step definitions for the runner's toy features (test/gherkin/fixtures/),
// over the memory driver: issues filed and counted, and one regex pattern.

import { expect } from "bun:test";
import * as Effect from "effect/Effect";

import { defineSteps } from "../features/steps/registry.ts";

// The issues this scenario filed, in order.
type Toy = { readonly issues: Array<number> };

export const toySteps = defineSteps(
  (): Toy => ({ issues: [] }),
  ({ Given, Then, When }) => [
    Given("{word} is a persona on this machine", ({ domain }, login) => domain.personas([login])),
    When("someone files an issue labelled {string}", ({ domain, state }, label) =>
      domain.fileIssue([label], "code").pipe(
        Effect.map((number) => {
          state.issues.push(number);
        }),
      ),
    ),
    When("someone files {int} issues", ({ domain, state }, count) =>
      Effect.forEach(
        Array.from({ length: count }, () => domain.fileIssue([], "code")),
        (filing) =>
          filing.pipe(
            Effect.map((number) => {
              state.issues.push(number);
            }),
          ),
        { discard: true },
      ),
    ),
    Then("there is {int} issue", ({ domain }, count) =>
      domain.world.pipe(
        Effect.map((world) => {
          expect(world.issues).toHaveLength(count);
        }),
      ),
    ),
    Then("there are {int} issues", ({ domain }, count) =>
      domain.world.pipe(
        Effect.map((world) => {
          expect(world.issues).toHaveLength(count);
        }),
      ),
    ),
    Then("the issue is labelled {string}", ({ domain, state }, label) =>
      domain.world.pipe(
        Effect.map((world) => {
          expect(world.issues.find((issue) => issue.number === state.issues[0])?.labels).toEqual([
            label,
          ]);
        }),
      ),
    ),
    Then(/^the issues are numbered ([\d, ]+)$/, ({ state }, numbers) =>
      Effect.sync(() => {
        expect(state.issues.join(", ")).toBe(numbers);
      }),
    ),
  ],
);
