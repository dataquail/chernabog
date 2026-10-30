import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import { AccountsClash, RepoNotEnrolled } from "../domain/enrolled-repo/enrolled-repo.errors.ts";
import { EnrolledRepoSummary } from "../domain/enrolled-repo/enrolled-repo-summary.value-object.ts";
import { MachineOffer } from "../domain/enrolled-repo/machine-offer.value-object.ts";

// Picks the account a persona of the repo a person names spends, or one of
// its roles does, or clears the pick so the default applies again. Refused,
// with nothing written, when its accounts would clash. `offered` is what
// machine setup reports the machine spends.
export const SetPersonaAccountCommand = Command.make("SetPersonaAccountCommand", {
  payload: {
    name: Schema.String,
    persona: Schema.Option(Schema.String),
    role: Schema.Option(Schema.String),
    account: Schema.Option(Schema.String),
    offered: Schema.Struct(MachineOffer.fields),
  },
  success: EnrolledRepoSummary,
  failure: Schema.Union([RepoNotEnrolled, AccountsClash, PersistenceFailed]),
});

export type SetPersonaAccountPayload = Command.Payload<typeof SetPersonaAccountCommand>;
