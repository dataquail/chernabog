import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import { RepoNotEnrolled } from "../domain/enrolled-repo/enrolled-repo.errors.ts";
import { EnrolledRepoSummary } from "../domain/enrolled-repo/enrolled-repo-summary.value-object.ts";

// Points the entry a person names at its checkout's new place, `root`,
// keeping every setting.
export const RepointRepoCommand = Command.make("RepointRepoCommand", {
  payload: { name: Schema.String, root: Schema.String },
  success: EnrolledRepoSummary,
  failure: Schema.Union([RepoNotEnrolled, PersistenceFailed]),
});

export type RepointRepoPayload = Command.Payload<typeof RepointRepoCommand>;
