// Which versions of @chernabog/sdk this binary runs flows written against.
// A repo records one fact, the SDK version its flows were written against
// (its .chernabog/package.json pin), and a run records the SDK it started
// under; this binary alone decides whether it can run either. Before 1.0,
// almost every SDK minor breaks flows, so it runs the minor it bundles, and
// the one before when the minor it bundles only added to it.

import * as Option from "effect/Option";

// The one place the binary declares what it runs: from `from`, up to but not
// including `below`. Move it when the SDK's minor moves. 0.7 only added the
// FlowPackage service (#129), so flows written against 0.6 still run.
export const SUPPORTED_SDK = { from: "0.6.0", below: "0.8.0" } as const;

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
