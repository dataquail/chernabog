import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import { RepoNotEnrolled } from "../domain/enrolled-repo/enrolled-repo.errors.ts";
import { PauseState } from "./pause-repo.command.ts";

// Lets the paused repo a person names start runs again.
export const ResumeRepoCommand = Command.make("ResumeRepoCommand", {
  payload: { name: Schema.String },
  success: PauseState,
  failure: Schema.Union([RepoNotEnrolled, PersistenceFailed]),
});

export type ResumeRepoPayload = Command.Payload<typeof ResumeRepoCommand>;
