import { describe, expect, test } from "bun:test";

import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { Criteria } from "../../../../kernel/specification.ts";
import { ReloadRoot } from "./reload.root.ts";
import { ReloadSpecifications } from "./reload.specification.ts";

const reload = (repo: string) => ReloadRoot.make({ repo: RepoSlug.make(repo), tree: "aaaa" });

describe("ReloadSpecifications", () => {
  test("forRepo holds of the reload of that slug only, as an Eq on repo", () => {
    const spec = ReloadSpecifications.forRepo(RepoSlug.make("dataquail/demo"));
    expect(spec(reload("dataquail/demo"))).toBe(true);
    expect(spec(reload("dataquail/other"))).toBe(false);
    expect(spec.criteria).toEqual(Criteria.Eq({ field: "repo", value: "dataquail/demo" }));
  });
});
