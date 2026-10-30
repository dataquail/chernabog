import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import { RepoNotEnrolled } from "../domain/enrolled-repo/enrolled-repo.errors.ts";
import { EnrolledRepoSummary } from "../domain/enrolled-repo/enrolled-repo-summary.value-object.ts";

// Turns one flow on or off for a persona of the repo a person names. A flow
// turned off keeps its settings, as enabled: false.
export const SetPersonaFlowCommand = Command.make("SetPersonaFlowCommand", {
  payload: {
    name: Schema.String,
    persona: Schema.Option(Schema.String),
    flow: Schema.String,
    enabled: Schema.Boolean,
  },
  success: EnrolledRepoSummary,
  failure: Schema.Union([RepoNotEnrolled, PersistenceFailed]),
});

export type SetPersonaFlowPayload = Command.Payload<typeof SetPersonaFlowCommand>;
