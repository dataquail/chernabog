import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { type Holding, RunMarkerRootOps } from "./run-marker.root-ops.ts";

const AT = "2026-10-28T12:00:00.000Z";
const NOW = DateTime.makeUnsafe(AT);

const holding = (
  args: Schema.Json = { number: 12, label: "auto:in-progress" },
  keepOn: ReadonlyArray<string> = [],
): Holding => ({ runId: RunId.make("a"), name: "chernabog/label", args, keepOn });

describe("RunMarkerRootOps", () => {
  test("a hold is held, with no attempts", () => {
    const marker = RunMarkerRootOps.hold(holding(), AT);

    expect([marker.status, marker.attempts, marker.heldAt]).toEqual(["held", 0, AT]);
    expect(RunMarkerRootOps.isDue(marker, NOW)).toBe(true);
  });

  test("holding what the run holds changes nothing; holding what it let go holds it again", () => {
    const marker = RunMarkerRootOps.hold(holding(), AT);

    expect(RunMarkerRootOps.holdAgain(Option.some(marker), holding(), AT)).toEqual(Option.none());
    expect(
      Option.map(
        RunMarkerRootOps.holdAgain(
          Option.some(RunMarkerRootOps.released(marker, AT)),
          holding(),
          AT,
        ),
        (again) => again.status,
      ),
    ).toEqual(Option.some("held"));
    expect(Option.isSome(RunMarkerRootOps.holdAgain(Option.none(), holding(), AT))).toBe(true);
  });

  test("two holds are the same by run, name and arguments", () => {
    expect(RunMarkerRootOps.same(holding({ a: 1, b: 2 }), holding({ a: 1, b: 2 }))).toBe(true);
    expect(RunMarkerRootOps.same(holding({ a: 1 }), holding({ a: 2 }))).toBe(false);
  });

  test("a marker stays on its keepOn endings", () => {
    const marker = RunMarkerRootOps.hold(holding({}, ["needs-human"]), AT);

    expect(RunMarkerRootOps.keptOn(marker, "needs-human")).toBe(true);
    expect(RunMarkerRootOps.keptOn(marker, "failed")).toBe(false);
  });

  test("a release that fails is tried again after a backoff that doubles, up to an hour", () => {
    const once = RunMarkerRootOps.failed(RunMarkerRootOps.hold(holding(), AT), "boom", NOW);

    expect([once.status, once.attempts, once.lastError]).toEqual(["held", 1, Option.some("boom")]);
    expect(once.nextAttemptAt).toEqual(Option.some("2026-10-28T12:00:30.000Z"));
    expect(RunMarkerRootOps.isDue(once, NOW)).toBe(false);
    expect(RunMarkerRootOps.isDue(once, DateTime.addDuration(NOW, Duration.seconds(30)))).toBe(
      true,
    );

    expect(Duration.toSeconds(RunMarkerRootOps.backoff(2))).toBe(60);
    expect(Duration.toSeconds(RunMarkerRootOps.backoff(20))).toBe(3600);
  });

  test("a settled marker is never due", () => {
    const marker = RunMarkerRootOps.hold(holding(), AT);

    for (const settled of [
      RunMarkerRootOps.released(marker, AT),
      RunMarkerRootOps.kept(marker, AT),
      RunMarkerRootOps.unreleasable(marker, "no definition", AT),
    ]) {
      expect(RunMarkerRootOps.isDue(settled, NOW)).toBe(false);
    }
  });

  test("a run's markers are released newest first", () => {
    const first = RunMarkerRootOps.hold(holding({ n: 1 }), AT);
    const second = RunMarkerRootOps.hold(holding({ n: 2 }), AT);

    expect(RunMarkerRootOps.releaseOrder([first, second])).toEqual([second, first]);
  });

  test("the sweep leaves an untried release to the run's ending, until it has had its chance", () => {
    const untried = RunMarkerRootOps.hold(holding(), AT);
    const tried = RunMarkerRootOps.failed(untried, "GitHub is down", NOW);
    const later = DateTime.addDuration(NOW, RunMarkerRootOps.SWEEP_GRACE);

    // Just ended: its ending's reaction may still be releasing it.
    expect(RunMarkerRootOps.leftToSweep(untried, Option.some(AT), NOW)).toBe(false);
    // Once the grace has passed, a crash must have kept the reaction from it.
    expect(RunMarkerRootOps.leftToSweep(untried, Option.some(AT), later)).toBe(true);
    // A release the reaction tried and failed is the sweep's to retry.
    expect(RunMarkerRootOps.leftToSweep(tried, Option.some(AT), NOW)).toBe(true);
    // A run that kept no end time has nothing to wait for.
    expect(RunMarkerRootOps.leftToSweep(untried, Option.none(), NOW)).toBe(true);
  });

  test("a run's ending releases only what nothing has tried yet", () => {
    const untried = RunMarkerRootOps.hold(holding(), AT);

    expect(RunMarkerRootOps.untried(untried)).toBe(true);
    expect(RunMarkerRootOps.untried(RunMarkerRootOps.failed(untried, "down", NOW))).toBe(false);
  });
});
