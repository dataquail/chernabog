// What every driver shares, so that one scenario means the same on each: the
// cast (which flows each persona runs), and how a driver reads what it sees
// into the domain layer's terms (what counts as a reply to a review, a hand-off,
// a pull request opened for an issue). A driver that set these up or counted
// them its own way could pass a scenario another fails.

import { DEFAULT_LABELS } from "@chernabog/sdk";
import * as Option from "effect/Option";

import type { Fix, Login, Verdict } from "../domain.ts";

// The review loop's recipes, in the order a driver offers a persona work.
export const RECIPES: ReadonlyArray<string> = [
  "implement",
  "address-review",
  "review",
  "re-review",
];

// Who writes: the personas that run the writing flows, as the review loop
// has alice write (test/features/review-loop.feature).
const WRITERS: ReadonlyArray<Login> = ["alice"];

const WRITING: ReadonlyArray<string> = ["implement", "address-review"];

const REVIEWING: ReadonlyArray<string> = ["review", "re-review"];

// The recipes `login` runs, in RECIPES' order: the writing flows for a
// writer, and the reviewing flows for a persona that reviews for the team
// (one in the reviewer `pool`), so a persona reviews only once a scenario
// says it does.
export const flowsOf = (login: Login, pool: ReadonlyArray<Login>): ReadonlyArray<string> =>
  RECIPES.filter(
    (name) =>
      (WRITING.includes(name) && WRITERS.includes(login)) ||
      (REVIEWING.includes(name) && pool.includes(login)),
  );

// Who a person's review request is by, or a push no persona made, as the
// world shows it.
export const A_PERSON = "a person";

// What a comment that answers a review starts with: the author's reasons for
// not addressing it, or what it changed.
const ANSWERS_A_REVIEW = /^(Not addressing|Addressed) review \d+/;

export const answersAReview = (body: string) => ANSWERS_A_REVIEW.test(body);

// The reasons a comment that answers a review gives for not making the
// changes it asks for, when it gives any.
const DECLINES = /^Not addressing review \d+:\s*([\s\S]*)$/;

export const reasonsOf = (body: string): Option.Option<string> =>
  Option.fromNullishOr(DECLINES.exec(body)).pipe(
    Option.map((found) => found[1].trim()),
    Option.filter((reasons) => reasons !== ""),
  );

// The label that hands a pull request to a person.
export const NEEDS_HUMAN = DEFAULT_LABELS.needsHuman;

// Whether a label added to a pull request hands it to a person.
export const handsOff = (label: string) => label === NEEDS_HUMAN;

// Who hands a pull request back when a scenario says "someone" does: a
// person who may write to the repo, as a hand-back needs.
export const A_MAINTAINER = "maya";

// The spec a writing persona's change touches, when it touches one: a
// behavior file, as the spec guard reads them.
export const SPEC = "test/features/filed-work.feature";

// Whether a run of the writing recipe `flow` changes the spec, as well as
// code: implement when the issue's fix does, and address-review when its
// persona changes the spec when fixing.
export const changesTheSpec = (
  flow: string,
  writer: { readonly fix: Fix; readonly changingWhenFixing: boolean },
) =>
  (flow === "implement" && writer.fix === "a spec") ||
  (flow === "address-review" && writer.changingWhenFixing);

// The branch implement works an issue on.
export const branchOf = (issue: number) => `auto/issue-${issue}`;

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
