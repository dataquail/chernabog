import { type RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type TrustRecordRoot } from "./trust-record.root.ts";

// The record of one repo, by its slug.
const forRepo = (repo: RepoSlug): Specification<TrustRecordRoot> =>
  Spec.eq<TrustRecordRoot, "repo">("repo", repo);

export const TrustRecordSpecifications = { forRepo } as const;
