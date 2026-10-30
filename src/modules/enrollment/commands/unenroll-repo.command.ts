import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import { RepoNotEnrolled } from "../domain/enrolled-repo/enrolled-repo.errors.ts";
import { EnrolledRepoSummary } from "../domain/enrolled-repo/enrolled-repo-summary.value-object.ts";

// Removes the repo a person names from this machine, settings and all.
export const UnenrollRepoCommand = Command.make("UnenrollRepoCommand", {
  payload: { name: Schema.String },
  success: EnrolledRepoSummary,
  failure: Schema.Union([RepoNotEnrolled, PersistenceFailed]),
});

export type UnenrollRepoPayload = Command.Payload<typeof UnenrollRepoCommand>;
