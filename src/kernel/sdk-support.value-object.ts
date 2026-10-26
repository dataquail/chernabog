// Which versions of @chernabog/sdk this binary runs flows written against.
// A repo records one fact, the SDK version its flows were written against
// (its .chernabog/package.json pin), and a run records the SDK it started
// under; this binary alone decides whether it can run either. Before 1.0,
// almost every SDK minor breaks flows, so it runs the minor it bundles.

import * as Option from "effect/Option";

// The SDK this binary bundles, as packages/sdk/package.json has it.
// release-please moves both together (release-please-config.json), and
// flow-deps.test.ts fails if they drift.
export const BUNDLED_SDK_VERSION = "0.6.0"; // x-release-please-version

const [major, minor] = BUNDLED_SDK_VERSION.split(".").map(Number);

// What the binary runs: from `from`, up to but not including `below`, which is
// the minor it bundles.
export const SUPPORTED_SDK = { from: `${major}.${minor}.0`, below: `${major}.${minor + 1}.0` };

export const supportedRange = `>=${SUPPORTED_SDK.from} <${SUPPORTED_SDK.below}`;

// A version as a pin may write it: exact, or with a ^, ~ or = in front.
const VERSION = /^[\^~=]?\s*(\d+\.\d+\.\d+(?:-[\w.]+)?)$/;

// The version a pin names; none when it's a range or not a version at all.
export const pinnedVersion = (pin: string) =>
  Option.flatMap(Option.fromNullishOr(VERSION.exec(pin.trim())), (match) =>
    Option.fromUndefinedOr(match[1]),
  );

// How a version stands against what this binary runs: runnable, or which side
// is behind.
export type SdkSupport = "supported" | "older" | "newer";

export const sdkSupport = (version: string): SdkSupport => {
  if (Bun.semver.order(version, SUPPORTED_SDK.from) < 0) {
    return "older";
  }

  if (Bun.semver.order(version, SUPPORTED_SDK.below) >= 0) {
    return "newer";
  }

  return "supported";
};

export const supportsSdk = (version: string) => sdkSupport(version) === "supported";

// Why a run in flight that started under `version`, which this binary doesn't
// run, went to a person rather than resuming.
export const unsupportedRunSummary = (version: string) =>
  `it started under @chernabog/sdk ${version}, and this chernabog runs @chernabog/sdk ${supportedRange}, so it wasn't resumed`;
