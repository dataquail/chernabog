import { describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

import { ComputeTime, type StepSpan } from "./compute-time.domain-service.ts";

// Minutes past a fixed hour, as the ISO timestamps om_steps keeps.
const at = (minute: number) => `2026-11-09T08:${String(minute).padStart(2, "0")}:00.000Z`;
const minutes = (count: number) => count * 60_000;

// A step entered at a minute, and finished at another when one is given.
const step = (name: string, entered: number, ...finished: ReadonlyArray<number>): StepSpan => ({
  step: name,
  enteredAt: at(entered),
  finishedAt: Option.map(Arr.head(finished), at),
});

describe("ComputeTime.of, the time a run's steps cover, overlaps counted once", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly steps: ReadonlyArray<StepSpan>;
    readonly runFinishedAt: Option.Option<string>;
    readonly now: number;
    readonly computed: Option.Option<number>;
  }> = [
    {
      name: "two overlapping lanes count once, not as their sum",
      steps: [step("implement", 0, 10), step("review", 5, 20)],
      runFinishedAt: Option.some(at(20)),
      now: 60,
      computed: Option.some(minutes(20)),
    },
    {
      name: "a gap while parked between steps counts for nothing",
      steps: [step("implement", 0, 10), step("ci", 40, 45)],
      runFinishedAt: Option.some(at(45)),
      now: 60,
      computed: Option.some(minutes(15)),
    },
    {
      name: "an interrupted step ends where it was entered again",
      steps: [step("implement", 0), step("implement", 30, 35)],
      runFinishedAt: Option.some(at(35)),
      now: 60,
      computed: Option.some(minutes(35)),
    },
    {
      name: "an interrupted step on a cancelled run ends at the run's finish",
      steps: [step("implement", 0, 5), step("review", 5)],
      runFinishedAt: Option.some(at(12)),
      now: 60,
      computed: Option.some(minutes(12)),
    },
    {
      name: "the step a running run is in ends now",
      steps: [step("implement", 0, 5), step("review", 10)],
      runFinishedAt: Option.none(),
      now: 25,
      computed: Option.some(minutes(20)),
    },
    {
      name: "one interrupted step's next entry is of the same step, not the next step",
      steps: [step("implement", 0), step("review", 3, 4), step("implement", 8, 9)],
      runFinishedAt: Option.some(at(9)),
      now: 60,
      computed: Option.some(minutes(9)),
    },
    {
      name: "a run with no steps recorded has no compute time, not zero",
      steps: [],
      runFinishedAt: Option.some(at(30)),
      now: 60,
      computed: Option.none(),
    },
  ];

  for (const each of cases) {
    test(each.name, () => {
      expect(
        ComputeTime.of({ steps: each.steps, runFinishedAt: each.runFinishedAt, now: at(each.now) }),
      ).toEqual(each.computed);
    });
  }
});
