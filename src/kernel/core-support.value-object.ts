// Which @chernabog/core this binary provides to the flows it runs. Core is the
// contract between the binary and every repo's flows (docs/adr/0004): within a
// major it only grows, so a binary that provides core 1.N runs what was written
// against any 1.M up to it. A repo's flows are written from the
// @chernabog/sdk it pins, and that SDK's peer range on core says which core it
// needs; this binary alone decides whether it provides one in the range.

import * as Option from "effect/Option";

// The core this binary bundles, as packages/core/package.json has it.
// release-please moves both together (release-please-config.json), and
// flow-deps.test.ts fails if they drift.
export const BUNDLED_CORE_VERSION = "1.0.0"; // x-release-please-version

// Every core this binary provides, newest first: the one it bundles, and, once
// a major has changed a port, each major before it that it still provides
// through adapters over the new ports (ADR 0004). Drop one only in a major of
// chernabog's own.
export const PROVIDED_CORE: ReadonlyArray<string> = [BUNDLED_CORE_VERSION];

// What this binary provides, as a person reads it: `^1.0.0`.
export const providedRange = PROVIDED_CORE.map((version) => `^${version}`).join(" || ");

const majorOf = (version: string) => Number(version.split(".")[0]);

// A version as a pin may write it: exact, or with a ^, ~ or = in front.
const VERSION = /^[\^~=]?\s*(\d+\.\d+\.\d+(?:-[\w.]+)?)$/;

// The version a pin names; none when it's a range or not a version at all.
export const pinnedVersion = (pin: string) =>
  Option.flatMap(Option.fromNullishOr(VERSION.exec(pin.trim())), (match) =>
    Option.fromUndefinedOr(match[1]),
  );

// The lowest version a range names, such as 1.2.0 of `^1.2.0 || ^2.0.0`.
const lowestIn = (range: string) =>
  Option.fromUndefinedOr(
    [...range.matchAll(/\d+\.\d+\.\d+(?:-[\w.]+)?/g)]
      .map((match) => match[0])
      .toSorted((left, right) => Bun.semver.order(left, right))[0],
  );

// How a range of core, as an SDK declares it, stands against what this binary
// provides: provided, or which side is behind. `newer`: the SDK needs a core
// this binary doesn't have yet; `older`: it needs one this binary no longer
// provides.
export type CoreSupport = "supported" | "older" | "newer";

export const coreSupport = (range: string): CoreSupport => {
  if (PROVIDED_CORE.some((version) => Bun.semver.satisfies(version, range))) {
    return "supported";
  }

  if (
    Option.exists(lowestIn(range), (lowest) => Bun.semver.order(lowest, BUNDLED_CORE_VERSION) > 0)
  ) {
    return "newer";
  }

  return "older";
};

// Whether this binary may resume a run that started under core `version`:
// it provides that major, at that version or later, so every durable
// primitive the run's journal was written with means here what it meant then.
export const resumesRunsFrom = (version: string) =>
  Option.isSome(pinnedVersion(version)) &&
  PROVIDED_CORE.some(
    (provided) =>
      majorOf(provided) === majorOf(version) && Bun.semver.order(provided, version) >= 0,
  );

// Why a run in flight that started under `version`, which this binary can't
// resume, went to a person rather than resuming.
export const unsupportedRunSummary = (version: string) =>
  `it started under @chernabog/core ${version}, and this chernabog provides @chernabog/core ${providedRange}, so it wasn't resumed`;
