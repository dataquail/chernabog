import * as Schema from "effect/Schema";

import { RepoSlug } from "../../../kernel/repo-slug.id.ts";

// Whether a repo's trusted tree restarts the daemon: only the first time.
export class ReloadClaim extends Schema.Class<ReloadClaim, { readonly brand: "ReloadClaim" }>(
  "ReloadClaim",
)({
  repo: RepoSlug,
  tree: Schema.String,
  first: Schema.Boolean,
}) {}
