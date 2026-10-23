import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";

import { decideLaunch } from "./usage.value-object.ts";

const now = DateTime.makeUnsafe("2026-10-17T12:00:00Z");

const config = {
  targetEndUsage: 0.95,
  taskCostEstimate: 0.04,
  fiveHourCeiling: 0.4,
  humanRatePerHour: 0.005,
};

const reading = (fiveHour: number, sevenDay: number, hoursToReset: number) => ({
  fiveHour: { used: fiveHour, resetsAt: DateTime.add(now, { hours: 5 }) },
  sevenDay: { used: sevenDay, resetsAt: DateTime.add(now, { hours: hoursToReset }) },
});

describe("decideLaunch", () => {
  test("holds back at or over the five-hour ceiling", () => {
    expect(decideLaunch(reading(0.4, 0.1, 100), config, now)).toEqual({
      launch: false,
      reason: "five-hour usage 0.4 is at or over the 0.4 ceiling",
    });
  });

  test("launches while weekly headroom, after the person's own use, covers one more task", () => {
    expect(decideLaunch(reading(0.1, 0.5, 10), config, now).launch).toBe(true);

    const tight = decideLaunch(reading(0.1, 0.5, 90), config, now);

    expect(tight.launch).toBe(false);
    expect(tight.reason).toContain("is below the 0.04 task estimate");
  });
});
