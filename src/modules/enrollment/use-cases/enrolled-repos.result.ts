import * as Schema from "effect/Schema";

import { RepoSlug } from "../../../kernel/repo-slug.id.ts";

// What this machine offers a repo's personas, as machine setup reports it.
export type Offered = {
  readonly personas: ReadonlyArray<string>;
  readonly accounts: ReadonlyArray<{ readonly name: string; readonly agent: string }>;
};

// An enrolled repo, as another module or an adapter needs to name it and find
// its checkout.
export class EnrolledRepoSummary extends Schema.Class<
  EnrolledRepoSummary,
  { readonly brand: "EnrolledRepoSummary" }
>("EnrolledRepoSummary")({
  name: Schema.String,
  repo: RepoSlug,
  path: Schema.String,
}) {}

export class EnrolledRepos extends Schema.Class<EnrolledRepos, { readonly brand: "EnrolledRepos" }>(
  "EnrolledRepos",
)({
  repos: Schema.Array(EnrolledRepoSummary),
}) {}

// Why a flow is off when a person turned it off for a persona: a reason they
// know, so a presenter needn't repeat it.
export { FLOW_TURNED_OFF } from "../domain/enrolled-repo/team-flows.value-object.ts";
