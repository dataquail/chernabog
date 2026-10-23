import * as Schema from "effect/Schema";

import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";

// The tree of a repo's .chernabog/ it last restarted the daemon on. The
// daemon exits for launchd or systemd to start it again, so this outlives it:
// a trusted tree that fails to load restarts the daemon once, not on every
// check, since a restart on the same tree won't load it either.
export class ReloadRoot extends Schema.Class<ReloadRoot, { readonly brand: "ReloadRoot" }>(
  "ReloadRoot",
)({
  repo: RepoSlug,
  tree: Schema.String,
}) {}
