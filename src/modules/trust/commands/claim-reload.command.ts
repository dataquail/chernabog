import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";

// Whether a repo's trusted tree restarts the daemon: only the first time.
export class ReloadClaim extends Schema.Class<ReloadClaim, { readonly brand: "ReloadClaim" }>(
  "ReloadClaim",
)({
  repo: RepoSlug,
  tree: Schema.String,
  first: Schema.Boolean,
}) {}

// Claims a restart of the daemon on a repo's trusted tree, recording it, so
// the same tree never restarts it twice, whatever the repo's status.
export const ClaimReloadCommand = Command.make("ClaimReloadCommand", {
  payload: { repo: RepoSlug, tree: Schema.String },
  success: ReloadClaim,
  failure: PersistenceFailed,
});

export type ClaimReloadPayload = Command.Payload<typeof ClaimReloadCommand>;
