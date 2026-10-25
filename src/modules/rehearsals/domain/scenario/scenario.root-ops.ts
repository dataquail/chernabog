import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";

import { type Ending } from "../../../../kernel/scenario.value-object.ts";
import { type StandIns, unmatchedKeys } from "../../../../kernel/stand-in.value-object.ts";
import { RehearsesEnrolledRepo, ScenarioInvalid } from "./scenario.errors.ts";
import { type ScenarioRoot } from "./scenario.root.ts";
import { type Seeded } from "./seeded.value-object.ts";

const sameRepo = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

// Whether a scenario may seed its repo: never an enrolled one, unless the
// scenario (or the person, with `allow`) says so. Its answer is whether the
// repo is enrolled, so the caller pauses it here.
const target = (scenario: ScenarioRoot, enrolled: ReadonlyArray<string>, allow: boolean) => {
  const isEnrolled = enrolled.some((slug) => sameRepo(slug, scenario.repo));

  if (isEnrolled && !allow && scenario.enrolled !== true) {
    return Result.fail(
      new RehearsesEnrolledRepo({
        repo: scenario.repo,
        message: `${scenario.path}: ${scenario.repo} is enrolled on this machine, and a rehearsal adds labels, comments, requests reviews and merges there; rehearse on a scratch repo, or set enrolled: true in the scenario (or pass --on-enrolled) to mean it`,
      }),
    );
  }

  return Result.succeed(isEnrolled);
};

// The flow a scenario rehearses: the one named on the command line, which the
// scenario's own flow: must match when it gives one.
const flowOf = (scenario: ScenarioRoot, named: string) =>
  Option.match(Option.fromUndefinedOr(scenario.flow), {
    onNone: () => Result.succeed(named),
    onSome: (own) => {
      if (own !== named) {
        return Result.fail(
          new ScenarioInvalid({
            message: `${scenario.path} rehearses ${own}, not ${named}`,
          }),
        );
      }

      return Result.succeed(own);
    },
  });

// One answer a finished run's agent gave, with the commits its step made.
export type ReplayedAnswer = {
  readonly step: string;
  readonly answer: Schema.Json;
  readonly commits: ReadonlyArray<string>;
};

// A finished run's answers as stand-ins: each step's answer as its fixture,
// with placeholder commits for the ones it made.
const replayed = (answers: ReadonlyArray<ReplayedAnswer>): StandIns =>
  Object.fromEntries(
    answers.map((answer) => [
      answer.step,
      { fixture: answer.answer, commits: [...answer.commits] },
    ]),
  );

// The stand-ins a rehearsal runs with: a replayed run's, and the scenario's
// own over them, so a scenario can change one step of a replay.
const standIns = (scenario: ScenarioRoot, replay: StandIns = {}): StandIns => ({
  ...replay,
  ...scenario.agent,
});

const ITEM_NUMBER = /^(?:issue|pr)-(\d+)(?:-|$)/;

// The issue or pull request a work item is about, by its key.
const numberOf = (key: string) =>
  Option.map(Option.fromNullishOr(ITEM_NUMBER.exec(key)), (match) => Number(match[1]));

// Whether a work item is about something seeding made: `issue-12`, `pr-7`,
// `pr-7-changes-2`. On an enrolled repo, a rehearsal works on nothing else.
const isSeeded = (seeded: Seeded, key: string) =>
  Option.exists(numberOf(key), (number) =>
    [...seeded.issues, ...seeded.pullRequests].some((made) => made.number === number),
  );

// How a rehearsal's run turned out, as the expectation compares it.
export type Outcome = {
  readonly ending: Ending;
  readonly summary: string;
  readonly labels: ReadonlyArray<string>;
};

const listed = (labels: ReadonlyArray<string>, none: string) =>
  Option.getOrElse(
    Option.liftPredicate(labels.join(", "), (text) => text.length > 0),
    () => none,
  );

const sameLabels = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) => {
  const lower = (labels: ReadonlyArray<string>) => labels.map((label) => label.toLowerCase());
  const [one, other] = [lower(left), lower(right)];

  return one.every((label) => other.includes(label)) && other.every((label) => one.includes(label));
};

// What the run did that the scenario's expect: said it wouldn't, one line each.
const missed = (scenario: ScenarioRoot, outcome: Outcome): ReadonlyArray<string> => {
  const expected = scenario.expect ?? {};

  const ends = Option.filter(
    Option.fromUndefinedOr(expected.ends),
    (ending) => ending !== outcome.ending,
  );

  const summary = Option.filter(
    Option.fromUndefinedOr(expected.summary),
    (phrase) => !outcome.summary.includes(phrase),
  );

  const labels = Option.filter(
    Option.fromUndefinedOr(expected.labels),
    (wanted) => !sameLabels(wanted, outcome.labels),
  );

  return [
    ...Option.toArray(Option.map(ends, (ending) => `ended ${outcome.ending}, not ${ending}`)),
    ...Option.toArray(
      Option.map(summary, (phrase) => `its summary doesn't say "${phrase}": ${outcome.summary}`),
    ),
    ...Option.toArray(
      Option.map(
        labels,
        (wanted) =>
          `the item carries ${listed(outcome.labels, "no labels")}, not ${listed(wanted, "none")}`,
      ),
    ),
  ];
};

// The stand-ins no step the run asked for used: a replayed step the flow no
// longer has, or a scenario's that never came up.
const unused = (answering: StandIns, asked: ReadonlyArray<string>) =>
  unmatchedKeys(answering, asked);

export const ScenarioRootOps = {
  target,
  flowOf,
  replayed,
  standIns,
  numberOf,
  isSeeded,
  missed,
  unused,
} as const;
