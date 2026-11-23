// Step definitions: how a step's text in a feature becomes a call on the
// domain layer (ADR 22, decision 5). A definition is Given, When or Then with
// a pattern and a body. The body gets the scenario (the domain layer and the
// scenario's own state) and the step's captures, and nothing else.
//
// A string pattern is matched whole, and its placeholders capture typed
// values: {word} a run of non-space characters, {string} the text inside
// double quotes, {int} a whole number. Any other {name} is literal text. A
// RegExp pattern must match the whole step, and its groups capture strings.
//
// Matching ignores the keyword, as Cucumber's does: Given, When and Then say
// what a definition is for, and a feature's And and But take the keyword
// before them, but "Then alice opens a pull request" finds a definition
// written with When. A step's text that more than one definition matches is
// ambiguous, whatever their keywords.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import type { Domain, DomainFailed } from "../domain.ts";

// What a step's body is given: the domain layer and the scenario's state,
// which starts fresh for each scenario.
export type Scenario<S> = {
  readonly domain: Domain;
  readonly state: S;
};

type Capture = string | number;

type Placeholder = "word" | "string" | "int";

type CaptureOf<K extends Placeholder> = K extends "int" ? number : string;

// The typed captures a string pattern's placeholders give, in order.
export type Captures<P extends string> = P extends `${string}{${infer K}}${infer Rest}`
  ? K extends Placeholder
    ? [CaptureOf<K>, ...Captures<Rest>]
    : Captures<Rest>
  : [];

export type Keyword = "Given" | "When" | "Then";

export type StepDefinition<S> = {
  readonly keyword: Keyword;
  // The pattern as written, to name the definition in an error.
  readonly pattern: string;
  // The captures from a step's text, when the definition matches it.
  readonly match: (text: string) => Option.Option<ReadonlyArray<Capture>>;
  readonly run: (
    scenario: Scenario<S>,
    captures: ReadonlyArray<Capture>,
  ) => Effect.Effect<void, DomainFailed>;
};

// A feature's step definitions, and the state each scenario starts with.
export type Steps<S> = {
  readonly initial: () => S;
  readonly definitions: ReadonlyArray<StepDefinition<S>>;
};

const PLACEHOLDERS: Record<Placeholder, { readonly source: string; readonly int: boolean }> = {
  word: { source: "(\\S+)", int: false },
  string: { source: '"([^"]*)"', int: false },
  int: { source: "(-?\\d+)", int: true },
};

const isPlaceholder = (name: string): name is Placeholder => Object.hasOwn(PLACEHOLDERS, name);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A pattern as a whole-text RegExp, and which of its groups are ints: a
// string pattern's placeholders become groups, a RegExp's groups are strings.
const compiled = (pattern: string | RegExp) => {
  if (pattern instanceof RegExp) {
    return { regex: pattern, ints: [] };
  }

  const ints: Array<boolean> = [];

  const source = pattern
    .split(/(\{[a-z]+\})/)
    .map((part) => {
      const name = part.slice(1, -1);

      if (part.startsWith("{") && isPlaceholder(name)) {
        ints.push(PLACEHOLDERS[name].int);

        return PLACEHOLDERS[name].source;
      }

      return escape(part);
    })
    .join("");

  return { regex: new RegExp(`^${source}$`), ints };
};

const captured = (ints: ReadonlyArray<boolean>) => (group: string, index: number) => {
  if (ints[index] === true) {
    return Number(group);
  }

  return group;
};

const matcher =
  ({ ints, regex }: { readonly regex: RegExp; readonly ints: ReadonlyArray<boolean> }) =>
  (text: string): Option.Option<ReadonlyArray<Capture>> =>
    Option.fromNullishOr(regex.exec(text)).pipe(
      Option.filter((found) => found[0] === text),
      Option.map((found) => found.slice(1).map(captured(ints))),
    );

// What a pattern's captures are: typed by its placeholders for a string,
// strings for a RegExp.
export type CapturesOf<P extends string | RegExp> = P extends string
  ? Captures<P>
  : ReadonlyArray<string>;

type Body<S, C extends ReadonlyArray<Capture>> = (
  scenario: Scenario<S>,
  ...captures: C
) => Effect.Effect<void, DomainFailed>;

type Define<S> = <const P extends string | RegExp>(
  pattern: P,
  body: Body<S, CapturesOf<P>>,
) => StepDefinition<S>;

// Whether captures are the ones a pattern's matcher makes, which they always
// are: the check is what lets their type follow the pattern's.
const fits = <P extends string | RegExp>(
  _pattern: P,
  ints: ReadonlyArray<boolean>,
  captures: ReadonlyArray<Capture>,
): captures is CapturesOf<P> =>
  captures.every((capture, index) => Predicate.isNumber(capture) === (ints[index] === true));

const define =
  <S>(keyword: Keyword): Define<S> =>
  (pattern, body) => {
    const pieces = compiled(pattern);

    return {
      keyword,
      pattern: String(pattern),
      match: matcher(pieces),
      run: (scenario, captures) => {
        if (fits(pattern, pieces.ints, captures)) {
          return body(scenario, ...captures);
        }

        return Effect.die(`${String(pattern)} was given captures it doesn't make`);
      },
    };
  };

export type Keywords<S> = {
  readonly Given: Define<S>;
  readonly When: Define<S>;
  readonly Then: Define<S>;
};

// A feature's step definitions, over state of type S that `initial` makes
// for each scenario:
//
//   defineSteps(() => ({ pullRequest: Option.none<number>() }), ({ Given, Then }) => [
//     Given("{word} is a persona on this machine", ({ domain }, login) => domain.personas([login])),
//     Then("there are {int} issues", ({ domain }, count) => ...),
//   ]);
export const defineSteps = <S>(
  initial: () => S,
  definitions: (keywords: Keywords<S>) => ReadonlyArray<StepDefinition<S>>,
): Steps<S> => ({
  initial,
  definitions: definitions({ Given: define("Given"), When: define("When"), Then: define("Then") }),
});

export type Matched<S> = {
  readonly definition: StepDefinition<S>;
  readonly captures: ReadonlyArray<Capture>;
};

// Every definition a step's text matches, with what each captures.
export const matching = <S>(steps: Steps<S>, text: string): ReadonlyArray<Matched<S>> =>
  steps.definitions.flatMap((definition) =>
    Option.toArray(
      definition.match(text).pipe(Option.map((captures) => ({ definition, captures }))),
    ),
  );
