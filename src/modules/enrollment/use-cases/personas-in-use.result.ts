import * as Schema from "effect/Schema";

// The GitHub logins enrolled repos run as, by their own entries, which the
// machine must keep acting as.
export class PersonasInUse extends Schema.Class<PersonasInUse, { readonly brand: "PersonasInUse" }>(
  "PersonasInUse",
)({
  logins: Schema.Array(Schema.String),
}) {}
