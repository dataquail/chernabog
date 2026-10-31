// The CI gate: green, red or pending from the checks GitHub reports on a pull
// request's head (core's GitHub.ciChecks), by the flow's policy. GitHub only
// reports; which checks gate a merge is decided here, and a recipe sets it
// with `ciGates` and `ciOptionalFailures` (Settings.Ci).

import { type CiChecks, type CiState, GitHub } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

import * as Settings from "./settings.ts";

export type Policy = {
  // The checks that must pass: the base branch's required ones (every check
  // when it requires none, or GitHub won't say), or every check, required
  // ones that haven't reported included.
  readonly gates: "required" | "every";
  // Whether a failing check that doesn't gate still makes CI red, so a fix
  // can start before the slow checks finish, or is left alone.
  readonly optionalFailures: "hold" | "ignore";
};

export const DEFAULT_POLICY: Policy = { gates: "required", optionalFailures: "hold" };

const sorted = (names: ReadonlyArray<string>) => Arr.sort(Arr.dedupe(names), Order.String);

// The checks' verdict: red when a check that counts failed, pending while a
// gating check hasn't passed (or none has reported at all), green otherwise.
export const verdict = (facts: CiChecks, policy: Policy): CiState => {
  const reported = facts.checks.map((check) => check.name);
  let gating = facts.required;

  // Every check is at least the required ones, reported yet or not.
  if (policy.gates === "every") {
    gating = Arr.dedupe([...facts.required, ...reported]);
  }

  if (gating.length === 0) {
    gating = reported;
  }

  const counts = (name: string) => policy.optionalFailures === "hold" || gating.includes(name);

  const failedChecks = sorted(
    facts.checks.flatMap((check) => {
      if (check.state === "failed" && counts(check.name)) {
        return [check.name];
      }

      return [];
    }),
  );

  const waitingOn = sorted(
    gating.filter(
      (name) => !facts.checks.some((check) => check.name === name && check.state !== "pending"),
    ),
  );

  let reading: CiState = { state: "green" };

  if (failedChecks.length > 0) {
    reading = { state: "red", failedChecks };
  } else if (waitingOn.length > 0 || gating.length === 0) {
    reading = { state: "pending", waitingOn };
  }

  return Option.match(facts.caveat, {
    onNone: () => reading,
    onSome: (caveat): CiState => ({ ...reading, caveat }),
  });
};

// The pull request's CI, read now and decided by the flow's policy.
export const pullRequestState = (pullRequest: number) =>
  Effect.gen(function* () {
    const policy = yield* Settings.ciGate;
    const facts = yield* GitHub.use((github) => github.ciChecks(pullRequest));

    return verdict(facts, policy);
  });
