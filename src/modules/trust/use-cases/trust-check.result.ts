import * as Schema from "effect/Schema";

import { RepoSlug } from "../../../kernel/repo-slug.id.ts";

// Whether a repo's .chernabog/ is trusted as git has it now: its tree on the
// base branch (none when there's no .chernabog/ there), and whether that's
// the tree a person trusted.
export class TrustCheck extends Schema.Class<TrustCheck, { readonly brand: "TrustCheck" }>(
  "TrustCheck",
)({
  repo: RepoSlug,
  tree: Schema.Option(Schema.String),
  trusted: Schema.Boolean,
}) {}
