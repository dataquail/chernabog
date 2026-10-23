import * as Schema from "effect/Schema";

// An account directory, in full and as the home spells it, and the agent its
// name says it's for, if it says.
export class AccountDir extends Schema.Class<AccountDir, { readonly brand: "AccountDir" }>(
  "AccountDir",
)({
  dir: Schema.String,
  display: Schema.String,
  agent: Schema.Option(Schema.String),
}) {}

// What setting up the machine can choose: gh's logins and the personas
// chosen before, and the account directories in the home not set up yet.
export class SetupPlan extends Schema.Class<SetupPlan, { readonly brand: "SetupPlan" }>(
  "SetupPlan",
)({
  loggedIn: Schema.Array(Schema.String),
  personas: Schema.Array(Schema.String),
  // Whether machine config lists accounts yet.
  accountsWritten: Schema.Boolean,
  candidates: Schema.Array(AccountDir),
}) {}

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

// The personas a machine acts as and the accounts it spends, for choosing a
// repo's.
export class MachineSetupView extends Schema.Class<
  MachineSetupView,
  { readonly brand: "MachineSetupView" }
>("MachineSetupView")({
  personas: Schema.Array(Schema.String),
  accounts: Schema.Array(Schema.Struct({ name: Schema.String, agent: Schema.String })),
}) {}
