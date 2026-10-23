// Whether a tick of a persona's flow may go ahead, and how many runs it may
// start: the machine's limits, checked before the flow's trigger and gate.

import type * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { withinHours } from "./schedule.value-object.ts";

export type Capacity = {
  readonly activeForFlow: number;
  readonly flowConcurrency: number;
  readonly activeOnMachine: number;
  readonly machineConcurrency: number;
};

export type TickDecision = { readonly go: true } | { readonly go: false; readonly reason: string };

export type TickConditions = {
  readonly enabled: boolean;
  // Why the flow doesn't run on this machine, if it doesn't.
  readonly flowOff: Option.Option<string>;
  readonly paused: boolean;
  readonly quietHours: Option.Option<string>;
  readonly activeHours: Option.Option<string>;
  readonly now: DateTime.Utc;
};

const stop = (reason: string): TickDecision => ({ go: false, reason });

// The machine's limits, checked before a flow's trigger and its own gate.
export const decideTick = (conditions: TickConditions): TickDecision => {
  if (!conditions.enabled) {
    return stop("disabled in machine config");
  }

  if (Option.isSome(conditions.flowOff)) {
    return stop(conditions.flowOff.value);
  }

  if (conditions.paused) {
    return stop("paused");
  }

  const quiet = Option.filter(conditions.quietHours, (hours) => withinHours(hours, conditions.now));

  if (Option.isSome(quiet)) {
    return stop(`quiet hours (${quiet.value})`);
  }

  const outside = Option.filter(
    conditions.activeHours,
    (hours) => !withinHours(hours, conditions.now),
  );

  if (Option.isSome(outside)) {
    return stop(`outside active hours (${outside.value})`);
  }

  return { go: true };
};

export const freeSlots = (capacity: Capacity) =>
  Math.max(
    0,
    Math.min(
      capacity.flowConcurrency - capacity.activeForFlow,
      capacity.machineConcurrency - capacity.activeOnMachine,
    ),
  );
