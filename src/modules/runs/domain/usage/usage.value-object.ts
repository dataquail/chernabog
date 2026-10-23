// Whether an account's AI usage leaves room for another unattended run: under
// its five-hour ceiling, and with weekly headroom, after what the person is
// expected to use themselves until the week resets, for one more task.

import * as DateTime from "effect/DateTime";

export type GateConfig = {
  readonly targetEndUsage: number;
  readonly taskCostEstimate: number;
  readonly fiveHourCeiling: number;
  readonly humanRatePerHour: number;
};

type UsageWindow = { readonly used: number; readonly resetsAt: DateTime.Utc };

export type UsageReading = { readonly fiveHour: UsageWindow; readonly sevenDay: UsageWindow };

export type LaunchDecision = { readonly launch: boolean; readonly reason: string };

const HOUR_MS = 60 * 60 * 1000;
const FLOAT_TOLERANCE = 1e-9;

export const decideLaunch = (
  reading: UsageReading,
  config: GateConfig,
  now: DateTime.Utc,
): LaunchDecision => {
  if (reading.fiveHour.used >= config.fiveHourCeiling) {
    return {
      launch: false,
      reason: `five-hour usage ${reading.fiveHour.used} is at or over the ${config.fiveHourCeiling} ceiling`,
    };
  }

  const hoursUntilWeeklyReset = Math.max(
    0,
    (DateTime.toEpochMillis(reading.sevenDay.resetsAt) - DateTime.toEpochMillis(now)) / HOUR_MS,
  );

  const remainingBudget = config.targetEndUsage - reading.sevenDay.used;
  const expectedHumanUse = config.humanRatePerHour * hoursUntilWeeklyReset;
  const headroom = remainingBudget - expectedHumanUse;
  const summary = `weekly headroom ${headroom.toFixed(3)} (budget ${remainingBudget.toFixed(3)} − human ${expectedHumanUse.toFixed(3)} over ${hoursUntilWeeklyReset.toFixed(1)}h)`;

  if (headroom + FLOAT_TOLERANCE < config.taskCostEstimate) {
    return {
      launch: false,
      reason: `${summary} is below the ${config.taskCostEstimate} task estimate`,
    };
  }

  return { launch: true, reason: `${summary} covers the ${config.taskCostEstimate} task estimate` };
};
