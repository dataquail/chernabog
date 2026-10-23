import * as Schema from "effect/Schema";

import { RepoSlug } from "../../../kernel/repo-slug.id.ts";

// A repo after pausing or resuming it: whether it's paused now, and whether
// that changed anything.
export class PauseState extends Schema.Class<PauseState, { readonly brand: "PauseState" }>(
  "PauseState",
)({
  name: Schema.String,
  repo: RepoSlug,
  paused: Schema.Boolean,
  changed: Schema.Boolean,
}) {}
