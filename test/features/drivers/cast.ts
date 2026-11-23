// What every driver shares, so that one scenario means the same on each: the
// cast (which flows each persona runs), and how a driver reads what it sees
// into the domain layer's terms (what counts as a reply to a review, a hand-off,
// a pull request opened for an issue). A driver that set these up or counted
// them its own way could pass a scenario another fails.

import { DEFAULT_LABELS } from "@chernabog/sdk";
import * as Option from "effect/Option";

import type { Login, Verdict } from "../domain.ts";

// The review loop's recipes, in the order a driver offers a persona work.
export const RECIPES: ReadonlyArray<string> = [
  "implement",
  "address-review",
  "review",
  "re-review",
];

// The flows each persona runs, as the sandbox's review loop sets alice and
// bob up (test/acceptance/review.test.ts): alice writes, bob reviews.
const FLOWS_OF: Readonly<Record<Login, ReadonlyArray<string>>> = {
  alice: ["implement", "address-review"],
  bob: ["review", "re-review"],
};

// The recipes `login` runs, in RECIPES' order: all of them for a persona the
// cast doesn't name.
export const flowsOf = (login: Login): ReadonlyArray<string> =>
  Option.match(Option.fromUndefinedOr(FLOWS_OF[login]), {
    onNone: () => RECIPES,
    onSome: (names) => RECIPES.filter((name) => names.includes(name)),
  });

// Who a person's review request is by, or a push no persona made, as the
// world shows it.
export const A_PERSON = "a person";

// What a comment that answers a review starts with: the author's reasons for
// not addressing it, or what it changed.
const ANSWERS_A_REVIEW = /^(Not addressing|Addressed) review \d+/;

export const answersAReview = (body: string) => ANSWERS_A_REVIEW.test(body);

// Whether a label added to a pull request hands it to a person.
export const handsOff = (label: string) => label === DEFAULT_LABELS.needsHuman;

// The issue a pull request was opened for, by its head branch: implement's
// auto/issue-<n>.
export const issueOfBranch = (branch: string): Option.Option<number> =>
  Option.map(Option.fromNullishOr(/^auto\/issue-(\d+)$/.exec(branch)), (found) => Number(found[1]));

// A review's verdict, by its state on GitHub.
const VERDICT_OF = new Map<string, Verdict>([
  ["APPROVED", "approved"],
  ["CHANGES_REQUESTED", "changes-requested"],
  ["COMMENTED", "commented"],
]);

export const verdictOf = (state: string): Verdict =>
  Option.getOrElse(Option.fromUndefinedOr(VERDICT_OF.get(state)), (): Verdict => "commented");
