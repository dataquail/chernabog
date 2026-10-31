import { describe, expect, test } from "bun:test";

import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { Criteria } from "../../../../kernel/specification.ts";
import { TrustRecordRoot } from "./trust-record.root.ts";
import { TrustRecordSpecifications } from "./trust-record.specification.ts";

const record = (repo: string) =>
  TrustRecordRoot.make({ repo: RepoSlug.make(repo), tree: "aaaa", at: "2026-10-22T00:00:00Z" });

describe("TrustRecordSpecifications", () => {
  test("forRepo holds of the record of that slug only, as an Eq on repo", () => {
    const spec = TrustRecordSpecifications.forRepo(RepoSlug.make("dataquail/demo"));
    expect(spec(record("dataquail/demo"))).toBe(true);
    expect(spec(record("dataquail/other"))).toBe(false);
    expect(spec.criteria).toEqual(Criteria.Eq({ field: "repo", value: "dataquail/demo" }));
  });
});
