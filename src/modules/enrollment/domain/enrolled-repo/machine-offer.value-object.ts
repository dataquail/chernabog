import * as Schema from "effect/Schema";

// What this machine offers a repo's personas: the GitHub logins it acts as
// and the AI accounts its runs can spend. Machine setup owns them; enrolling
// is given them.
export class MachineOffer extends Schema.Class<MachineOffer, { readonly brand: "MachineOffer" }>(
  "MachineOffer",
)({
  personas: Schema.Array(Schema.String),
  accounts: Schema.Array(Schema.Struct({ name: Schema.String, agent: Schema.String })),
}) {}
