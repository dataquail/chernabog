import { type RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type ReloadRoot } from "./reload.root.ts";

// The reload of one repo, by its slug.
const forRepo = (repo: RepoSlug): Specification<ReloadRoot> =>
  Spec.eq<ReloadRoot, "repo">("repo", repo);

export const ReloadSpecifications = { forRepo } as const;
