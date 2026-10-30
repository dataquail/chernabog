import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import { RepoNotEnrolled } from "../domain/enrolled-repo/enrolled-repo.errors.ts";
import { EnrolledRepoSummary } from "../domain/enrolled-repo/enrolled-repo-summary.value-object.ts";

export class EnrolledRepos extends Schema.Class<EnrolledRepos, { readonly brand: "EnrolledRepos" }>(
  "EnrolledRepos",
)({
  repos: Schema.Array(EnrolledRepoSummary),
}) {}

// The repos a command acts on: the one a person names, or, with none named,
// every enrolled repo.
export const ListEnrolledReposQuery = Query.make("ListEnrolledReposQuery", {
  payload: { name: Schema.Option(Schema.String) },
  success: EnrolledRepos,
  failure: Schema.Union([PersistenceFailed, RepoNotEnrolled]),
});

export type ListEnrolledReposPayload = Query.Payload<typeof ListEnrolledReposQuery>;
