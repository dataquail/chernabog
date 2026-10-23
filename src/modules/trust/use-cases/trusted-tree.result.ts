import * as Schema from "effect/Schema";

import { RepoSlug } from "../../../kernel/repo-slug.id.ts";

// The tree of a repo's .chernabog/ a person trusts, if any.
export class TrustedTree extends Schema.Class<TrustedTree, { readonly brand: "TrustedTree" }>(
  "TrustedTree",
)({
  repo: RepoSlug,
  tree: Schema.Option(Schema.String),
}) {}
