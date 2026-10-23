import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { TrustRecordRoot } from "./trust-record.root.ts";
import { TrustRecordRootOps } from "./trust-record.root-ops.ts";

const repo = RepoSlug.make("dataquail/demo");

const trusted = Option.some(
  TrustRecordRoot.make({ repo, tree: "aaaa", at: "2026-10-01T00:00:00.000Z" }),
);

const at = "2026-10-22T00:00:00.000Z";

describe("TrustRecordRootOps.trusts", () => {
  test("trusts only the tree it approved, and nothing without a record", () => {
    expect(TrustRecordRootOps.trusts(trusted, "aaaa")).toBe(true);
    expect(TrustRecordRootOps.trusts(trusted, "bbbb")).toBe(false);
    expect(TrustRecordRootOps.trusts(Option.none(), "aaaa")).toBe(false);
  });
});

describe("TrustRecordRootOps.approve", () => {
  test("a first approval records the tree and when", () => {
    expect(TrustRecordRootOps.approve(Option.none(), repo, "aaaa", at)).toEqual(
      Option.some(TrustRecordRoot.make({ repo, tree: "aaaa", at })),
    );
  });

  test("approving a changed tree replaces the one trusted before", () => {
    expect(TrustRecordRootOps.approve(trusted, repo, "bbbb", at)).toEqual(
      Option.some(TrustRecordRoot.make({ repo, tree: "bbbb", at })),
    );
  });

  test("approving the tree already trusted changes nothing", () => {
    expect(TrustRecordRootOps.approve(trusted, repo, "aaaa", at)).toEqual(Option.none());
  });
});
