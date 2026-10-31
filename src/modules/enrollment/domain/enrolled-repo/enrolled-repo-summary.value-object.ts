import * as Schema from "effect/Schema";

import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";

// An enrolled repo, as another module or an adapter needs to name it and find
// its checkout: what listing the repos answers, and what changing one returns.
export class EnrolledRepoSummary extends Schema.Class<
  EnrolledRepoSummary,
  { readonly brand: "EnrolledRepoSummary" }
>("EnrolledRepoSummary")({
  name: Schema.String,
  repo: RepoSlug,
  path: Schema.String,
}) {}
