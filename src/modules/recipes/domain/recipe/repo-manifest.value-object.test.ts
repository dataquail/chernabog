import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  decodeRepoManifest,
  dependencyKind,
  sdkVersionOf,
  withCopied,
} from "./repo-manifest.value-object.ts";

const TEXT =
  '{ "private": true, "devDependencies": { "@chernabog/sdk": "0.6.0", "@acme/r": "1.0.0" }, "chernabog": { "other": 1 } }';

describe("a repo's .chernabog/package.json", () => {
  test("says which list declares a package, and the SDK its flows are written against", () => {
    const manifest = Result.getOrThrow(decodeRepoManifest(TEXT));

    expect(dependencyKind(manifest, "@acme/r")).toEqual(Option.some("devDependencies"));
    expect(dependencyKind(manifest, "@acme/x")).toEqual(Option.none());
    expect(sdkVersionOf(manifest)).toEqual(Option.some("0.6.0"));
  });

  test("records copies in path order, keeping the keys it doesn't name, and drops one removed", () => {
    const record = { from: "@acme/r/deploy", version: "1.0.0" };

    const written = Result.getOrThrow(
      withCopied(TEXT, {
        "prompts/deploy.md": Option.some(record),
        "flows/deploy.ts": Option.some(record),
      }),
    );

    expect(written).toBe(`{
  "private": true,
  "devDependencies": {
    "@chernabog/sdk": "0.6.0",
    "@acme/r": "1.0.0"
  },
  "chernabog": {
    "other": 1,
    "copied": {
      "flows/deploy.ts": {
        "from": "@acme/r/deploy",
        "version": "1.0.0"
      },
      "prompts/deploy.md": {
        "from": "@acme/r/deploy",
        "version": "1.0.0"
      }
    }
  }
}
`);

    const removed = Result.getOrThrow(
      withCopied(written, {
        "flows/deploy.ts": Option.none(),
        "prompts/deploy.md": Option.none(),
      }),
    );

    expect(removed).not.toContain("copied");
    expect(removed).toContain('"other": 1');
  });
});
