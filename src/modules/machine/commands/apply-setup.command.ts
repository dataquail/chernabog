import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import {
  AccountAgentUnknown,
  AccountDirMissing,
  NotLoggedIn,
  PersonaStillInUse,
} from "../domain/machine-setup/machine-setup.errors.ts";

export class AddedAccount extends Schema.Class<AddedAccount, { readonly brand: "AddedAccount" }>(
  "AddedAccount",
)({
  name: Schema.String,
  display: Schema.String,
  agent: Schema.String,
}) {}

// What setting up chose: the personas now, when they were chosen (none when
// they were left as they were), gh's logins, and the accounts added.
export class SetupOutcome extends Schema.Class<SetupOutcome, { readonly brand: "SetupOutcome" }>(
  "SetupOutcome",
)({
  personas: Schema.Option(Schema.Array(Schema.String)),
  before: Schema.Array(Schema.String),
  loggedIn: Schema.Array(Schema.String),
  added: Schema.Array(AddedAccount),
}) {}

// Sets up the machine as a person chose, where they chose: the GitHub
// personas it acts as, and the AI accounts its runs spend. None leaves a
// choice to the defaults, which are what a person would pick with nothing to
// weigh.
export const ApplySetupCommand = Command.make("ApplySetupCommand", {
  payload: {
    // The GitHub logins to act as, replacing the ones there. None adds gh's
    // only login, when it has one, and leaves them otherwise.
    personas: Schema.Option(Schema.Array(Schema.String)),
    // Account directories to add, each dir or dir:agent, ~ for the home. None
    // adds the one found, on a machine with no accounts yet, and none otherwise.
    accounts: Schema.Option(Schema.Array(Schema.String)),
    // The logins enrolled repos run as, which the personas must keep.
    inUse: Schema.Array(Schema.String),
  },
  success: SetupOutcome,
  failure: Schema.Union([
    NotLoggedIn,
    PersonaStillInUse,
    AccountAgentUnknown,
    AccountDirMissing,
    PersistenceFailed,
  ]),
});

export type ApplySetupPayload = Command.Payload<typeof ApplySetupCommand>;
