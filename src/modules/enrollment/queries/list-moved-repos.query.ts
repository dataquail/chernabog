import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";

// An entry whose checkout is gone: its name, the name it was given when it
// was given one, the repo it's of, and where its checkout was.
export class MovedRepo extends Schema.Class<MovedRepo, { readonly brand: "MovedRepo" }>(
  "MovedRepo",
)({
  name: Schema.String,
  named: Schema.Option(Schema.String),
  repo: RepoSlug,
  path: Schema.String,
}) {}

export class MovedRepos extends Schema.Class<MovedRepos, { readonly brand: "MovedRepos" }>(
  "MovedRepos",
)({
  repos: Schema.Array(MovedRepo),
}) {}

// Entries of the repo a checkout is of whose checkout is gone: what a person
// setting up a checkout at its new place may point there. None for a checkout
// that isn't of a GitHub repo.
export const ListMovedReposQuery = Query.make("ListMovedReposQuery", {
  payload: { root: Schema.String },
  success: MovedRepos,
  failure: PersistenceFailed,
});

export type ListMovedReposPayload = Query.Payload<typeof ListMovedReposQuery>;
