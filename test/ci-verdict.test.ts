// The SDK's CI gate: green, red or pending from the checks GitHub reports on
// a pull request's head, by the flow's policy.

import { Ci, type CiCheck, type CiChecks, Repo, Settings } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "./effect-test.ts";
import { settings } from "./sdk-fakes.ts";

const check = (name: string, state: CiCheck["state"], required: boolean): CiCheck => ({
  name,
  kind: "check-run",
  state,
  required,
  url: `https://ci.example.com/${name}`,
});

const facts = (checks: ReadonlyArray<CiCheck>, required: ReadonlyArray<string>): CiChecks => ({
  headSha: "abc1234",
  checks,
  required,
  caveat: Option.none(),
});

const EVERY: Ci.Policy = { gates: "every", optionalFailures: "hold" };
const IGNORING: Ci.Policy = { gates: "required", optionalFailures: "ignore" };

describe("Ci.verdict", () => {
  effect("is pending with nothing to wait on before any check reports", () =>
    Effect.sync(() => {
      expect(Ci.verdict(facts([], []), Ci.DEFAULT_POLICY)).toEqual({
        state: "pending",
        waitingOn: [],
      });
    }),
  );

  effect("waits on the required checks only, unless every check gates", () =>
    Effect.sync(() => {
      const reading = facts(
        [check("test", "passed", true), check("docs", "pending", false)],
        ["test"],
      );

      expect(Ci.verdict(reading, Ci.DEFAULT_POLICY)).toEqual({ state: "green" });
      expect(Ci.verdict(reading, EVERY)).toEqual({ state: "pending", waitingOn: ["docs"] });
    }),
  );

  effect("counts every check when the base branch requires none", () =>
    Effect.sync(() => {
      const reading = facts([check("test", "passed", false), check("docs", "pending", false)], []);
      expect(Ci.verdict(reading, IGNORING)).toEqual({ state: "pending", waitingOn: ["docs"] });
    }),
  );

  effect("is red on a failing required check, whatever optional failures do", () =>
    Effect.sync(() => {
      const reading = facts(
        [check("test", "failed", true), check("docs", "failed", false)],
        ["test"],
      );

      expect(Ci.verdict(reading, IGNORING)).toEqual({ state: "red", failedChecks: ["test"] });
      expect(Ci.verdict(reading, Ci.DEFAULT_POLICY)).toEqual({
        state: "red",
        failedChecks: ["docs", "test"],
      });
    }),
  );

  effect("is red on a failing optional check while required ones still run, by default", () =>
    Effect.sync(() => {
      const reading = facts(
        [check("test", "pending", true), check("docs", "failed", false)],
        ["test"],
      );

      expect(Ci.verdict(reading, Ci.DEFAULT_POLICY)).toEqual({
        state: "red",
        failedChecks: ["docs"],
      });
      expect(Ci.verdict(reading, IGNORING)).toEqual({ state: "pending", waitingOn: ["test"] });
    }),
  );

  effect("carries the caveat GitHub's answer came with", () =>
    Effect.sync(() => {
      const reading = {
        ...facts([check("test", "passed", false)], []),
        caveat: Option.some("why"),
      };
      expect(Ci.verdict(reading, Ci.DEFAULT_POLICY)).toEqual({ state: "green", caveat: "why" });
    }),
  );
});

describe("Settings.ciGate", () => {
  effect(
    "reads the flow's policy, holding on any failure and gating on required checks by default",
    () =>
      Effect.gen(function* () {
        const reading = (input: Record<string, unknown>) =>
          Settings.ciGate.pipe(
            Effect.provideService(Repo, settings),
            Effect.provideService(Settings.FlowSettings, { input }),
          );

        expect(yield* reading({})).toEqual(Ci.DEFAULT_POLICY);
        expect(yield* reading({ ciGates: "every", ciOptionalFailures: "ignore" })).toEqual({
          gates: "every",
          optionalFailures: "ignore",
        });
      }),
  );
});
