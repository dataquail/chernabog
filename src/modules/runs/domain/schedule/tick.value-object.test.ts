import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { decideTick, freeSlots } from "./tick.value-object.ts";

const local = DateTime.zoneMakeLocal();

// A wall-clock time today, in this machine's zone.
const at = (clock: string) =>
  DateTime.toUtc(
    DateTime.makeZonedUnsafe(`2026-10-17T${clock}:00`, {
      timeZone: local,
      adjustForTimeZone: true,
    }),
  );

describe("machine limits", () => {
  const open = {
    enabled: true,
    flowOff: Option.none<string>(),
    paused: false,
    quietHours: Option.none<string>(),
    activeHours: Option.none<string>(),
    now: at("12:00"),
  };

  test("a tick goes ahead unless something holds it back, and says what", () => {
    expect(decideTick(open).go).toBe(true);
    expect(decideTick({ ...open, paused: true })).toEqual({ go: false, reason: "paused" });
    expect(decideTick({ ...open, quietHours: Option.some("11:00-13:00") })).toEqual({
      go: false,
      reason: "quiet hours (11:00-13:00)",
    });
    expect(decideTick({ ...open, activeHours: Option.some("13:00-17:00") })).toEqual({
      go: false,
      reason: "outside active hours (13:00-17:00)",
    });
    expect(decideTick({ ...open, flowOff: Option.some("flow turned off") })).toEqual({
      go: false,
      reason: "flow turned off",
    });
  });

  test("free slots are the smaller of the flow and the machine limit", () => {
    expect(
      freeSlots({
        activeForFlow: 0,
        flowConcurrency: 2,
        activeOnMachine: 1,
        machineConcurrency: 2,
      }),
    ).toBe(1);
    expect(
      freeSlots({
        activeForFlow: 1,
        flowConcurrency: 1,
        activeOnMachine: 1,
        machineConcurrency: 4,
      }),
    ).toBe(0);
  });
});
