import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";

// The enrolled repos that are paused, by slug.
export class PausedRepos extends Schema.Class<PausedRepos, { readonly brand: "PausedRepos" }>(
  "PausedRepos",
)({
  repos: Schema.Array(RepoSlug),
}) {}

// The enrolled repos that are paused now, which the daemon starts nothing in.
export const ListPausedReposQuery = Query.make("ListPausedReposQuery", {
  success: PausedRepos,
  failure: PersistenceFailed,
});
