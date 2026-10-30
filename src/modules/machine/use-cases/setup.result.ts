import * as Schema from "effect/Schema";

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
