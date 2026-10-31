import { describe, expect, test } from "bun:test";

import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { Criteria, Spec } from "../../../../kernel/specification.ts";
import { EnrolledRepoRoot } from "./enrolled-repo.root.ts";
import { EnrolledRepoSpecifications } from "./enrolled-repo.specification.ts";

const repo = (slug: string, path: string, paused: boolean) =>
  EnrolledRepoRoot.make({ repo: RepoSlug.make(slug), path, defaults: {}, paused });

const demo = repo("dataquail/demo", "/code/demo", false);
const clone = repo("dataquail/demo", "/code/demo-2", true);
const other = repo("dataquail/other", "/code/other", false);

describe("EnrolledRepoSpecifications", () => {
  test("all holds of every repo", () => {
    expect([demo, clone, other].filter(EnrolledRepoSpecifications.all)).toEqual([
      demo,
      clone,
      other,
    ]);
  });

  test("paused holds of the paused repos, as an Eq on paused", () => {
    expect([demo, clone, other].filter(EnrolledRepoSpecifications.paused)).toEqual([clone]);
    expect(EnrolledRepoSpecifications.paused.criteria).toEqual(
      Criteria.Eq({ field: "paused", value: true }),
    );
  });

  test("forRepo and atPath compose into a repo's other clones", () => {
    const elsewhere = Spec.and(
      EnrolledRepoSpecifications.forRepo(RepoSlug.make("dataquail/demo")),
      Spec.not(EnrolledRepoSpecifications.atPath("/code/demo")),
    );

    expect([demo, clone, other].filter(elsewhere)).toEqual([clone]);
  });
});
