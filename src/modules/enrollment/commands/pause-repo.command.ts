import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { RepoNotEnrolled } from "../domain/enrolled-repo/enrolled-repo.errors.ts";

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

// Pauses the repo a person names: it starts no new runs, and the runs in flight continue.
export const PauseRepoCommand = Command.make("PauseRepoCommand", {
  payload: { name: Schema.String },
  success: PauseState,
  failure: Schema.Union([RepoNotEnrolled, PersistenceFailed]),
});

export type PauseRepoPayload = Command.Payload<typeof PauseRepoCommand>;
