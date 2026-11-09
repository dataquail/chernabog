import { type Json } from "@chernabog/core";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { githubTestLayer } from "../../../../platform/github-api.ts";
import { checkThreadsSetup, missingRules, setupFix, writeRulesets } from "./threads-setup.ts";

const SLUG = "acme/app";
const PROBE = `/repos/${SLUG}/rules/branches/chernabog/threads/doctor-probe`;

const PROTECTED = [
  { type: "creation", ruleset_id: 1 },
  { type: "update", ruleset_id: 1 },
  { type: "deletion", ruleset_id: 2 },
  { type: "non_fast_forward", ruleset_id: 2 },
];

// GitHub as one login sees it: the rules on the probe branch, and whether it bypasses each ruleset.
const github = (
  rules: { readonly status: number; readonly body: Json },
  bypass: Readonly<Record<number, string>> = {},
) =>
  githubTestLayer((method, path) => {
    if (method === "GET" && path === PROBE) {
      return Option.some(rules);
    }

    const ruleset = /\/rulesets\/(\d+)$/.exec(path);

    return Option.map(Option.fromNullishOr(ruleset?.[1]), (id) => ({
      status: 200,
      body: Option.match(Option.fromUndefinedOr(bypass[Number(id)]), {
        onNone: (): Json => ({ id: Number(id) }),
        onSome: (said): Json => ({ id: Number(id), current_user_can_bypass: said }),
      }),
    }));
  });

// What doctor finds of the threads on that GitHub.
const setupOn = (layer: ReturnType<typeof github>) =>
  checkThreadsSetup(SLUG).pipe(Effect.provide(layer));

describe("the rules a thread needs", () => {
  test("are creation and update for the personas, deletion and force pushes for admins", () => {
    expect(missingRules(PROTECTED)).toEqual([]);
    expect(missingRules([{ type: "required_status_checks" }, { type: "update" }])).toEqual([
      "creation",
      "deletion",
      "non_fast_forward",
    ]);
  });

  test("a persona must bypass every ruleset that holds a write rule", () => {
    expect(writeRulesets([...PROTECTED, { type: "update", ruleset_id: 3 }])).toEqual([1, 3]);
  });

  test("the fix names the pattern and the docs, and a personal repo's limit", () => {
    expect(setupFix(SLUG, false)).toContain("refs/heads/chernabog/threads/*");
    expect(setupFix(SLUG, false)).toContain("/operate/progress/");
    expect(setupFix(SLUG, true)).toContain("a personal repo has no teams");
  });
});

describe("checkThreadsSetup", () => {
  effect("a repo that can't have rulesets says why", () =>
    Effect.gen(function* () {
      const found = yield* setupOn(
        github({
          status: 403,
          body: {
            message: "Upgrade to GitHub Pro or make this repository public to enable this feature.",
          },
        }),
      );

      expect(found).toEqual({
        status: "unavailable",
        reason: "Upgrade to GitHub Pro or make this repository public to enable this feature.",
      });
    }),
  );

  effect("rules missing from the threads leave the record unprotected", () =>
    Effect.gen(function* () {
      const found = yield* setupOn(github({ status: 200, body: [] }));

      expect(found).toEqual({
        status: "unprotected",
        missing: ["creation", "update", "deletion", "non_fast_forward"],
      });
    }),
  );

  effect("a persona on the write ruleset's bypass list may write", () =>
    Effect.gen(function* () {
      const found = yield* setupOn(
        github({ status: 200, body: PROTECTED }, { 1: "always", 2: "never" }),
      );

      expect(found).toEqual({ status: "protected", writes: Option.some(true) });
    }),
  );

  effect("a persona off the bypass list may not", () =>
    Effect.gen(function* () {
      const found = yield* setupOn(github({ status: 200, body: PROTECTED }, { 1: "never" }));

      expect(found).toEqual({ status: "protected", writes: Option.some(false) });
    }),
  );

  effect("a ruleset that won't say whether the persona bypasses it is unknown", () =>
    Effect.gen(function* () {
      const found = yield* setupOn(github({ status: 200, body: PROTECTED }));

      expect(found).toEqual({ status: "protected", writes: Option.none() });
    }),
  );
});
