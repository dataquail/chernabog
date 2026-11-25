// The bounds a hub holds each spoke to (ADR 23, decision 4): the bytes of its
// telemetry and of its run log, the wall-clock time of its phase, how long it
// may go without progress, and the resident memory of its process group. A
// spoke past one is ended, and its run fails naming the bound it broke.

import * as ByteSize from "effect/ByteSize";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";

export type SpokeBounds = {
  // Bytes in the spoke's telemetry files, summed over every day folder.
  readonly telemetry: number;
  // Bytes in the run's log.
  readonly runLog: number;
  // Wall-clock time since the spoke started.
  readonly phaseTime: Duration.Duration;
  // Time since any of the run's files last grew: its journal, its run log,
  // an agent session's transcript.
  readonly idle: Duration.Duration;
  // Resident memory of the spoke's process group, summed.
  readonly memory: number;
};

export const DEFAULT_SPOKE_BOUNDS: SpokeBounds = {
  telemetry: 256_000_000,
  runLog: 32_000_000,
  phaseTime: Duration.hours(4),
  idle: Duration.minutes(30),
  memory: 2_000_000_000,
};

export type SpokeBound = keyof SpokeBounds;

// What the hub measured of one spoke. Memory is none when the OS couldn't say.
export type SpokeMeasure = {
  readonly telemetry: number;
  readonly runLog: number;
  readonly phaseTime: Duration.Duration;
  readonly idle: Duration.Duration;
  readonly memory: Option.Option<number>;
};

// A bound a spoke broke: which, what was measured, and the limit, each as a
// person reads it.
export type SpokeBreach = {
  readonly bound: SpokeBound;
  readonly measured: string;
  readonly limit: string;
};

// "256 MB", "1.5 GB": a size as config writes it, in bytes; none for text
// that isn't one.
export const parseByteSize = (text: string): Option.Option<number> =>
  Option.flatMap(ByteSize.fromString(text), ByteSize.toNumber);

export const formatBytes = (bytes: number) =>
  ByteSize.format(ByteSize.bytes(Math.max(0, Math.floor(bytes))), { system: "decimal" });

// To the second: a bound's limit and what was measured, without the
// milliseconds a sample happened to land on.
export const formatDuration = (duration: Duration.Duration) =>
  Duration.format(Duration.seconds(Math.floor(Duration.toSeconds(duration))));

const overBytes = (bound: SpokeBound, measured: number, limit: number) =>
  Option.liftPredicate(
    { bound, measured: formatBytes(measured), limit: formatBytes(limit) },
    () => measured > limit,
  );

const overTime = (bound: SpokeBound, measured: Duration.Duration, limit: Duration.Duration) =>
  Option.liftPredicate(
    { bound, measured: formatDuration(measured), limit: formatDuration(limit) },
    () => Duration.isGreaterThan(measured, limit),
  );

// The first bound a spoke is past, in the order the ADR lists them; none
// while it is within every one.
export const breachOf = (measure: SpokeMeasure, bounds: SpokeBounds): Option.Option<SpokeBreach> =>
  Option.firstSomeOf([
    overBytes("telemetry", measure.telemetry, bounds.telemetry),
    overBytes("runLog", measure.runLog, bounds.runLog),
    overTime("phaseTime", measure.phaseTime, bounds.phaseTime),
    overTime("idle", measure.idle, bounds.idle),
    Option.flatMap(measure.memory, (memory) => overBytes("memory", memory, bounds.memory)),
  ]);

// How many spokes of one item in a row may exit before saying how their run
// ended (a crash, a SIGKILL from outside) before the hub stops repeating its
// phase (ADR 23, decision 2): machine config's `spokes: silentExits`.
export const DEFAULT_SILENT_EXITS = 3;

// How the hub ends a run whose spoke exited before saying how it ended, given
// how many runs of its item in a row ended so before it: interrupted, so the
// phase repeats in a new run, as after its hub's restart; or, once that makes
// `limit` in a row, failed, so the item isn't offered again and a person sees
// why. With the count it records, this run included.
export const silentExitEnding = (before: number, limit: number) => {
  const silentExits = before + 1;

  if (silentExits >= limit) {
    return { ending: "failed" as const, silentExits };
  }

  return { ending: "interrupted" as const, silentExits };
};

// The bounds' names as a person reads them, in a run's summary.
const NAMES: Readonly<Record<SpokeBound, string>> = {
  telemetry: "telemetry",
  runLog: "run log",
  phaseTime: "phase time",
  idle: "idle",
  memory: "memory",
};

// What a run that broke a bound ends with, as its summary.
export const breachSummary = (breach: SpokeBreach) =>
  `ended past its ${NAMES[breach.bound]} bound: ${breach.measured} over ${breach.limit}`;
