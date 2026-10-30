import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import { InvalidSchedule, RepoNotEnrolled } from "../domain/enrolled-repo/enrolled-repo.errors.ts";
import { EnrolledRepoSummary } from "../domain/enrolled-repo/enrolled-repo-summary.value-object.ts";

// Overrides a flow's schedule for a persona of the repo a person names, or,
// with none, clears the override so the team's applies again. Refused, with
// nothing written, when the schedule isn't a cron expression.
export const SetFlowScheduleCommand = Command.make("SetFlowScheduleCommand", {
  payload: {
    name: Schema.String,
    persona: Schema.Option(Schema.String),
    flow: Schema.String,
    schedule: Schema.Option(Schema.String),
  },
  success: EnrolledRepoSummary,
  failure: Schema.Union([RepoNotEnrolled, InvalidSchedule, PersistenceFailed]),
});

export type SetFlowSchedulePayload = Command.Payload<typeof SetFlowScheduleCommand>;
