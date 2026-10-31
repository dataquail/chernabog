import { type RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type EnrolledRepoRoot } from "./enrolled-repo.root.ts";

// Every repo enrolled on this machine.
const all: Specification<EnrolledRepoRoot> = Spec.all<EnrolledRepoRoot>();

// The repos that start no new runs.
const paused: Specification<EnrolledRepoRoot> = Spec.eq<EnrolledRepoRoot, "paused">("paused", true);

// Every clone of one repo, by its slug.
const forRepo = (repo: RepoSlug): Specification<EnrolledRepoRoot> =>
  Spec.eq<EnrolledRepoRoot, "repo">("repo", repo);

// The clone whose checkout is at `path`.
const atPath = (path: string): Specification<EnrolledRepoRoot> =>
  Spec.eq<EnrolledRepoRoot, "path">("path", path);

export const EnrolledRepoSpecifications = { all, paused, forRepo, atPath } as const;
