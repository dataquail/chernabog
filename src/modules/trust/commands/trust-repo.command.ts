import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { ConfigTreeUnavailable } from "../domain/trust-record/trust-record.errors.ts";

// What trusting a repo's .chernabog/ found and did: the tree on its base
// branch, the one trusted before, what changed between them (none when it was
// already trusted), and whether it's newly trusted.
export class TrustOutcome extends Schema.Class<TrustOutcome, { readonly brand: "TrustOutcome" }>(
  "TrustOutcome",
)({
  repo: RepoSlug,
  tree: Schema.String,
  previous: Schema.Option(Schema.String),
  changes: Schema.Option(Schema.String),
  trusted: Schema.Boolean,
}) {}

// A person approves the .chernabog/ on a repo's default branch, given its
// checkout, so the daemon runs its flows: what changed since the tree trusted
// before comes back for them to read. Only a person may do this, so no
// agent-facing adapter offers it.
export const TrustRepoCommand = Command.make("TrustRepoCommand", {
  payload: { repo: RepoSlug, path: Schema.String },
  success: TrustOutcome,
  failure: Schema.Union([ConfigTreeUnavailable, PersistenceFailed]),
});

export type TrustRepoPayload = Command.Payload<typeof TrustRepoCommand>;
